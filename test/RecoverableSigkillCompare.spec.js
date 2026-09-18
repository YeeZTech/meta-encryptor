/**
 * SIGKILL 中断 + 恢复：默认 inplace；保留少量双路径对照。
 *   1. 双文件、同目录（对照）
 *   2. 单文件 inplace
 *   3. inplace + saveFrequency=1
 *
 * 流程：
 *   子进程解密 → 达到绝对进度阈值后 SIGKILL → 再起子进程续解 → 再 SIGKILL
 *   → 父进程最终续解到完成 → 校验 MD5。
 */
const meta = require('../src/index.node.js');
import {Sealer} from '../src/node/Sealer';
const {PipelineContextInFile} = require('../src/node/PipelineConext.js');
const {RecoverableReadStream, RecoverableWriteStream} = require('../src/node/Recoverable.js');
import fs from 'fs';
import log from 'loglevel';
import {calculateMD5, key_pair, generateFileWithSize, testPath} from './helper';

const path = require('path');
const { spawn } = require('child_process');

log.setLevel('error');

const workerScript = path.resolve(__dirname, 'workers/interrupt-decrypt-worker.cjs');
const buildEntry = path.resolve(__dirname, '../build/commonjs/index.node.cjs');

const PLAIN_SIZE = 1024 * 1024 * 64;
// 绝对明文进度阈值（含续传基线）；两轮 SIGKILL
const KILL_POINTS = [1024 * 1024 * 2, 1024 * 1024 * 8];
const KILL_DELAY_MS = 150;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function parseWorkerEvents(buf, events) {
    for (const line of buf.toString('utf8').split('\n')) {
        const idx = line.indexOf('WORKER_JSON:');
        if (idx < 0) continue;
        try {
            events.push(JSON.parse(line.slice(idx + 'WORKER_JSON:'.length)));
        } catch (_) {}
    }
}

/** 等待任一目标事件；error/fatal 直接失败（携带子进程报错，便于定位）。 */
function waitForWorkerEvent(events, names, timeoutMs) {
    const wanted = Array.isArray(names) ? names : [names];
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
            const bad = events.find((e) => e.event === 'error' || e.event === 'fatal');
            if (bad) {
                reject(new Error(`worker reported ${bad.event}: ${bad.error}`));
                return;
            }
            const hit = events.find((e) => wanted.includes(e.event));
            if (hit) return resolve(hit);
            if (Date.now() - t0 > timeoutMs) {
                reject(new Error(
                    `timeout waiting for worker event ${JSON.stringify(wanted)}; got ${JSON.stringify(events)}`
                ));
                return;
            }
            setTimeout(tick, 30);
        };
        tick();
    });
}

function spawnWorker(configPath) {
    const child = spawn(process.execPath, [workerScript, configPath], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
    });
    const events = [];
    child.stdout.on('data', (b) => parseWorkerEvents(b, events));
    child.stderr.on('data', (b) => {
        if (b.toString().includes('WORKER_JSON:')) parseWorkerEvents(b, events);
    });
    return { child, events };
}

function killAndWait(child) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, 5000);
        child.once('exit', () => {
            clearTimeout(t);
            resolve();
        });
        child.kill('SIGKILL');
    });
}

async function inspectContext(label, contextPath, outPath) {
    try {
        const ctx = new PipelineContextInFile(contextPath);
        await ctx.loadContext();
        const c = ctx.context || {};
        console.log(
            `[${label}] context: readStart=${c.readStart} writeStart=${c.writeStart} ` +
            `readItemCount=${c.readItemCount} dataLen=${c.data ? c.data.length : 0} ` +
            `outSize=${fs.existsSync(outPath) ? fs.statSync(outPath).size : 'N/A'}`
        );
    } catch (e) {
        console.log(`[${label}] context inspect failed: ${e.message}`);
    }
}

async function sealFile(src) {
    const dst = src + '.sealed';
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dst);
    rs.pipe(new Sealer({keyPair: key_pair})).pipe(ws);
    await new Promise((resolve) => ws.on('finish', resolve));
    return dst;
}

/**
 * 跑一个完整场景：两轮子进程 SIGKILL + 父进程最终续解。
 * 返回最终输出文件的 MD5。
 */
async function runKillResumeScenario(label, { sealedPath, outPath, contextPath, configPath, contextOptions }) {
    for (let round = 0; round < KILL_POINTS.length; round++) {
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                sealedPath,
                outPath,
                contextPath,
                mode: 'kill',
                midPlainBytes: KILL_POINTS[round],
                midDetect: 'progress',
                cleanBefore: false,
                contextOptions,
                privateKey: key_pair.private_key,
                publicKey: key_pair.public_key,
            })
        );

        const { child, events } = spawnWorker(configPath);
        try {
            await waitForWorkerEvent(events, 'started', 60_000);
            const hit = await waitForWorkerEvent(events, ['mid-decrypt', 'completed'], 120_000);
            if (hit.event === 'completed') {
                console.log(`[${label}] round ${round}: completed before kill point, stopping kills`);
                await killAndWait(child);
                break;
            }
            await sleep(KILL_DELAY_MS);
            await killAndWait(child);
            console.log(`[${label}] round ${round}: SIGKILL at plainBytes>=${hit.bytes}`);
            await inspectContext(`${label} after-kill-${round}`, contextPath, outPath);
        } catch (e) {
            await killAndWait(child);
            throw new Error(`[${label}] round ${round} failed: ${e.message}`);
        }
    }

    // 父进程最终续解到完成
    const context = new PipelineContextInFile(contextPath, contextOptions || {});
    await context.loadContext();

    await new Promise((resolve, reject) => {
        const rs = new RecoverableReadStream(sealedPath, context);
        const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
        const ws = new RecoverableWriteStream(outPath, context);
        for (const s of [rs, unsealer, ws]) {
            s.on('error', (err) => reject(new Error(`[${label}] final resume error: ${err.message}`)));
        }
        rs.pipe(unsealer).pipe(ws);
        ws.on('finish', resolve);
    });

    return calculateMD5(outPath);
}

/** 准备一个场景目录：生成明文、加密、按场景摆放路径。 */
async function prepareScenario(name, { sameFile, outDirName }) {
    const dirA = testPath(`${name}_a`);
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.mkdirSync(dirA, { recursive: true });

    let outDir = dirA;
    if (outDirName) {
        outDir = testPath(outDirName);
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.mkdirSync(outDir, { recursive: true });
    }

    const plainPath = path.join(dirA, 'plain.file');
    generateFileWithSize(plainPath, PLAIN_SIZE);
    const plainMd5 = await calculateMD5(plainPath);
    const sealedPath = await sealFile(plainPath);
    fs.unlinkSync(plainPath);

    return {
        plainMd5,
        sealedPath,
        outPath: sameFile ? sealedPath : path.join(outDir, 'out.file'),
        contextPath: path.join(dirA, 'progress.ctx'),
        configPath: path.join(dirA, 'worker.json'),
    };
}

beforeAll(() => {
    if (!fs.existsSync(buildEntry)) {
        throw new Error('build/commonjs/index.node.cjs missing; run `npm run build` first');
    }
});

test('sigkill x2 then resume - two files, same directory (dual-path 对照)', async () => {
    const s = await prepareScenario('sk_samedir', { sameFile: false });
    const md5 = await runKillResumeScenario('same-dir', s);
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

test('sigkill x2 then resume - single file inplace', async () => {
    const s = await prepareScenario('sk_inplace', { sameFile: true });
    const md5 = await runKillResumeScenario('inplace', s);
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

// 对照场景（历史归因，2026-08）：
//   - 在 WAL 写前存档实现之前，默认 saveFrequency=32 的 inplace 必失败，
//     saveFrequency=1 是概率性缓解（每 item 提交即存档 + 写端反压）；
//   - strongConsistency(fsync) 与 SIGKILL 场景无关：fsync 防的是断电/内核
//     崩溃丢页缓存，进程被杀不丢页缓存，反而使吞吐下降近一倍。
// 现在 RecoverableWriteStream 对 inplace 自动启用写前存档（WAL），两种
// saveFrequency 均应稳定通过；保留本场景覆盖「WAL 与高频存档叠加」的组合。
test('sigkill x2 then resume - single file inplace, saveFrequency=1 mitigation', async () => {
    const s = await prepareScenario('sk_inplace_freq1', { sameFile: true });
    const md5 = await runKillResumeScenario('inplace-freq1', {
        ...s,
        contextOptions: { strongConsistency: false, saveFrequency: 1 },
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

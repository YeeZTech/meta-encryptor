/**
 * 双文件（密文 ≠ 输出，客户端 DecryptAction 的实际路径）SIGKILL 中断 + 续传。
 *
 * 写端"写完成与流水线解耦"后，双文件模式的 checkpoint 只记录
 * readStart = rawCommitted、data 为空，续传时从完好的密文文件重读 pending 区间。
 * 本文件针对该语义补覆盖：
 *   1. 默认参数（saveFrequency=32 / 在途 4 MiB）SIGKILL x2 → 续传
 *   2. 在途上限放开到整文件（写端永不反压，kill 时在途最多）SIGKILL x2 → 续传
 *   3. 在途上限 1 字节（每次写都走 _inflightWaiter 阻塞路径）SIGKILL x2 → 续传
 *   4. 多轮（4 次）SIGKILL + minSaveIntervalMs 拉长存档间隔 → 续传
 *   5. 进程内：默认在途确实大于 1 个 item、maxInflightBytes=1 确实触发等待；
 *      底层写错误只向上抛一次 'error'
 *
 * 明文用随机数据（而不是 helper 里的重复 64 KiB 模式），这样 item 乱序 / 重复
 * 也会被 MD5 捕获。
 */
const meta = require('../src/index.node.js');
import {Sealer} from '../src/node/Sealer';
const {PipelineContextInFile} = require('../src/node/PipelineConext.js');
const {RecoverableReadStream, RecoverableWriteStream} = require('../src/node/Recoverable.js');
import fs from 'fs';
import log from 'loglevel';
import {calculateMD5, key_pair, testPath} from './helper';

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

log.setLevel('error');

const workerScript = path.resolve(__dirname, 'workers/interrupt-decrypt-worker.cjs');
const buildEntry = path.resolve(__dirname, '../build/commonjs/index.node.cjs');

const MiB = 1024 * 1024;
const PLAIN_SIZE = 64 * MiB;
const ITEM_SIZE = 64 * 1024;
// 解耦后双文件解密约 200 MB/s，mid-decrypt 事件到达后再等太久 kill 就落到文件尾了
const KILL_DELAY_MS = 10;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function generateRandomFile(fp, size) {
    const fd = fs.openSync(fp, 'w');
    try {
        let left = size;
        while (left > 0) {
            const n = Math.min(left, 4 * MiB);
            fs.writeSync(fd, crypto.randomBytes(n), 0, n);
            left -= n;
        }
    } finally {
        fs.closeSync(fd);
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

function parseWorkerEvents(buf, events) {
    for (const line of buf.toString('utf8').split('\n')) {
        const idx = line.indexOf('WORKER_JSON:');
        if (idx < 0) continue;
        try {
            events.push(JSON.parse(line.slice(idx + 'WORKER_JSON:'.length)));
        } catch (_) {}
    }
}

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

/** 读取被杀后的 .progress，并断言双文件 checkpoint 语义。 */
async function loadAndAssertDualFileCheckpoint(label, contextPath, outPath, contextOptions) {
    const ctx = new PipelineContextInFile(contextPath, contextOptions || {});
    await ctx.loadContext();
    const c = ctx.context || {};
    const outSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    console.log(
        `[${label}] context: readStart=${c.readStart} writeStart=${c.writeStart} ` +
        `readItemCount=${c.readItemCount} dataLen=${c.data ? c.data.length : 0} outSize=${outSize}`
    );
    // 尚未产生任何 checkpoint（kill 得太早）时跳过断言
    if (c.readStart === undefined) return c;

    // 双文件：checkpoint 不携带 pending 密文
    expect(c.data ? c.data.length : 0).toBe(0);
    // 已提交明文不会超过磁盘上实际写出的字节（在途写入可能已落盘但未提交，
    // 所以 outSize ≥ writeStart 是允许的，续传完成后由 truncate 收尾）
    expect(c.writeStart).toBeLessThanOrEqual(outSize);
    // 明文 / 密文都按整 item 提交，writeStart 必是 item 大小的整数倍
    expect(c.writeStart % ITEM_SIZE).toBe(0);
    expect(c.readStart).toBeGreaterThan(0);
    return c;
}

/**
 * 两轮以上子进程 SIGKILL + 父进程最终续解，返回最终输出 MD5。
 * 每轮 kill 后断言 .progress 的双文件语义。
 */
async function runKillResumeScenario(label, s, { killPoints, contextOptions, writeStreamOptions, finalWriteStreamOptions }) {
    let checkpoints = 0;
    for (let round = 0; round < killPoints.length; round++) {
        fs.writeFileSync(
            s.configPath,
            JSON.stringify({
                sealedPath: s.sealedPath,
                outPath: s.outPath,
                contextPath: s.contextPath,
                mode: 'kill',
                midPlainBytes: killPoints[round],
                midDetect: 'progress',
                cleanBefore: false,
                contextOptions,
                writeStreamOptions,
                privateKey: key_pair.private_key,
                publicKey: key_pair.public_key,
            })
        );

        const { child, events } = spawnWorker(s.configPath);
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
            const c = await loadAndAssertDualFileCheckpoint(`${label} after-kill-${round}`, s.contextPath, s.outPath, contextOptions);
            if (c.readStart !== undefined) checkpoints++;
        } catch (e) {
            await killAndWait(child);
            throw new Error(`[${label}] round ${round} failed: ${e.message}`);
        }
    }
    // 至少有一轮是真正从 checkpoint 续传的，否则本用例没有测到东西
    expect(checkpoints).toBeGreaterThan(0);

    const context = new PipelineContextInFile(s.contextPath, contextOptions || {});
    await context.loadContext();
    await new Promise((resolve, reject) => {
        const rs = new RecoverableReadStream(s.sealedPath, context);
        const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
        const ws = new RecoverableWriteStream(s.outPath, context, finalWriteStreamOptions || writeStreamOptions);
        for (const st of [rs, unsealer, ws]) {
            st.on('error', (err) => reject(new Error(`[${label}] final resume error: ${err.message}`)));
        }
        rs.pipe(unsealer).pipe(ws);
        ws.on('finish', resolve);
    });

    // 续传完成后：在途写入多出的尾巴必须被 truncate 掉
    expect(fs.statSync(s.outPath).size).toBe(PLAIN_SIZE);
    // 密文文件在双文件模式下必须原封不动
    expect(await calculateMD5(s.sealedPath)).toStrictEqual(s.sealedMd5);
    return calculateMD5(s.outPath);
}

async function prepareScenario(name, size = PLAIN_SIZE) {
    const dir = testPath(`${name}_dual`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const plainPath = path.join(dir, 'plain.file');
    generateRandomFile(plainPath, size);
    const plainMd5 = await calculateMD5(plainPath);
    const sealedPath = await sealFile(plainPath);
    const sealedMd5 = await calculateMD5(sealedPath);
    fs.unlinkSync(plainPath);

    return {
        plainMd5,
        sealedMd5,
        sealedPath,
        outPath: path.join(dir, 'out.file'),
        contextPath: path.join(dir, 'out.file.progress'),
        configPath: path.join(dir, 'worker.json'),
    };
}

beforeAll(() => {
    if (!fs.existsSync(buildEntry)) {
        throw new Error('build/commonjs/index.node.cjs missing; run `npm run build` first');
    }
});

test('dual-file sigkill x2 then resume - defaults (saveFrequency=32, inflight 4MiB)', async () => {
    const s = await prepareScenario('dual_default');
    const md5 = await runKillResumeScenario('dual-default', s, {
        killPoints: [2 * MiB, 8 * MiB],
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

test('dual-file sigkill x2 then resume - unbounded inflight (writer never applies backpressure)', async () => {
    const s = await prepareScenario('dual_unbounded');
    const md5 = await runKillResumeScenario('dual-unbounded', s, {
        killPoints: [3 * MiB, 20 * MiB],
        // 在途上限 = 整个文件：kill 时磁盘上领先 checkpoint 的在途字节最多
        writeStreamOptions: { maxInflightBytes: PLAIN_SIZE },
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

test('dual-file sigkill x2 then resume - maxInflightBytes=1 (every write blocks on the waiter)', async () => {
    const s = await prepareScenario('dual_blocking');
    const md5 = await runKillResumeScenario('dual-blocking', s, {
        killPoints: [1 * MiB, 6 * MiB],
        writeStreamOptions: { maxInflightBytes: 1 },
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

test('dual-file sigkill x4 then resume - minSaveIntervalMs=200 widens checkpoint gaps', async () => {
    const s = await prepareScenario('dual_multi');
    const md5 = await runKillResumeScenario('dual-multi', s, {
        killPoints: [1 * MiB, 5 * MiB, 12 * MiB, 30 * MiB],
        contextOptions: { saveFrequency: 8, minSaveIntervalMs: 200 },
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 600000);

test('dual-file in-process: default inflight exceeds one item; maxInflightBytes=1 engages the waiter', async () => {
    const s = await prepareScenario('dual_inproc', 8 * MiB);

    async function decryptWatching(outPath, writeOpts) {
        const ctxPath = outPath + '.progress';
        fs.rmSync(ctxPath, { force: true });
        fs.rmSync(outPath, { force: true });
        const context = new PipelineContextInFile(ctxPath);
        await context.loadContext();
        const rs = new RecoverableReadStream(s.sealedPath, context);
        const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
        const ws = new RecoverableWriteStream(outPath, context, writeOpts);
        let maxInflight = 0;
        let waiterSeen = false;
        const origWrite = ws._writeChunk.bind(ws);
        ws._writeChunk = (chunk, enc, cb) => {
            origWrite(chunk, enc, cb);
            if (ws._inflightBytes > maxInflight) maxInflight = ws._inflightBytes;
            if (ws._inflightWaiter) waiterSeen = true;
        };
        await new Promise((resolve, reject) => {
            for (const st of [rs, unsealer, ws]) st.on('error', reject);
            rs.pipe(unsealer).pipe(ws);
            ws.on('finish', resolve);
        });
        expect(ws._inflightBytes).toBe(0);
        expect(await calculateMD5(outPath)).toStrictEqual(s.plainMd5);
        return { maxInflight, waiterSeen };
    }

    const dflt = await decryptWatching(s.outPath + '.default');
    // 解耦生效：在途字节确实超过一个 item（否则就是旧的逐次等待行为）
    expect(dflt.maxInflight).toBeGreaterThan(ITEM_SIZE);
    expect(dflt.maxInflight).toBeLessThanOrEqual(4 * MiB + ITEM_SIZE);

    const strict = await decryptWatching(s.outPath + '.strict', { maxInflightBytes: 1 });
    expect(strict.waiterSeen).toBe(true);
    expect(strict.maxInflight).toBeLessThanOrEqual(ITEM_SIZE);
}, 120000);

test('dual-file in-process: underlying write failure surfaces exactly one error and stops the pipeline', async () => {
    const s = await prepareScenario('dual_err', 4 * MiB);
    const context = new PipelineContextInFile(s.contextPath);
    await context.loadContext();
    const rs = new RecoverableReadStream(s.sealedPath, context);
    const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
    const ws = new RecoverableWriteStream(s.outPath, context);

    // 第 5 次底层写入失败（模拟磁盘满 / 句柄被回收）
    const boom = new Error('EIO simulated');
    boom.code = 'EIO';
    let n = 0;
    const innerWrite = ws.writeStream.write.bind(ws.writeStream);
    ws.writeStream.write = (chunk, enc, cb) => {
        n++;
        if (n === 5) {
            process.nextTick(() => cb(boom));
            return true;
        }
        return innerWrite(chunk, enc, cb);
    };

    const errors = [];
    let finished = false;
    ws.on('error', (e) => errors.push(e));
    ws.on('finish', () => { finished = true; });
    rs.on('error', () => {});
    unsealer.on('error', () => {});
    rs.pipe(unsealer).pipe(ws);

    await new Promise((resolve) => ws.once('close', resolve));
    await sleep(100);

    expect(errors.length).toBe(1);
    expect(errors[0]).toBe(boom);
    expect(finished).toBe(false);
    expect(ws.destroyed).toBe(true);
    expect(ws.writeStream.destroyed).toBe(true);
    rs.destroy();
    unsealer.destroy();
}, 60000);

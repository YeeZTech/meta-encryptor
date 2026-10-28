/**
 * 断点续传加密：子进程 SIGKILL / SIGTERM 中断 + 续传（与 RecoverableDualFileSigkill.spec.js 对称）。
 *   1. 默认参数（saveFrequency=32 / 在途 4 MiB）SIGKILL x2 → 续传
 *   2. 在途上限放开到整文件（写端永不反压）SIGKILL x2 → 续传
 *   3. 在途上限 1 字节（每次写都走 _inflightWaiter）SIGKILL x2 → 续传
 *   4. 多轮（4 次）SIGKILL + minSaveIntervalMs 拉长存档间隔 → 续传
 *   5. 转码路径（输入从源头读 + skipCommittedInput）SIGKILL x2 → 续传
 *   6. SIGTERM 优雅暂停 → 续传
 *
 * 每轮 kill 后断言 .progress 的加密断点语义；最终续传完成后要求与一次性加密的
 * data_hash / 文件大小一致、解密 MD5 与原文一致、源文件未被改动。
 */
import { Sealer } from '../src/node/Sealer';
import { Unsealer } from '../src/node/Unsealer';
import { SealedFileStream } from '../src/node/SealedFileStream';
import { PipelineContextInFile } from '../src/node/PipelineConext.js';
import { RecoverableSourceStream, RecoverableWriteStream } from '../src/node/Recoverable.js';
import { dataHashOfSealedFile } from '../src/node/SealedFileUtil.js';
import { buffer2header_t, buffer2block_info_t } from '../src/common/header_util.js';
import { HeaderSize, BlockInfoSize, MaxItemSize } from '../src/common/limits.js';
import fs from 'fs';
import log from 'loglevel';
import { pipeline } from 'stream/promises';
import { calculateMD5, key_pair, testPath } from './helper';

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

log.setLevel('error');

const workerScript = path.resolve(__dirname, 'workers/interrupt-seal-worker.cjs');
const buildEntry = path.resolve(__dirname, '../build/commonjs/index.node.cjs');

const MiB = 1024 * 1024;
// 末尾留一个不满 64 KiB 的 item
const PLAIN_SIZE = 64 * MiB + 12345;
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

function readTail(sealedPath) {
    const buf = fs.readFileSync(sealedPath);
    const header = buffer2header_t(buf.subarray(buf.length - HeaderSize));
    const blockStart = buf.length - HeaderSize - BlockInfoSize * header.block_number;
    const firstBlock = buffer2block_info_t(buf.subarray(blockStart, blockStart + BlockInfoSize));
    return { header, firstBlock };
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
            const bad = events.find((e) => e.event === 'error' || e.event === 'fatal' || e.event === 'graceful-exit-error');
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

function signalAndWait(child, signal) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        const t = setTimeout(resolve, 5000);
        child.once('exit', () => {
            clearTimeout(t);
            resolve();
        });
        child.kill(signal);
    });
}

/** 读取中断后的 .progress，并断言加密断点语义。 */
async function loadAndAssertSealCheckpoint(label, s) {
    const ctx = new PipelineContextInFile(s.contextPath);
    await ctx.loadContext();
    const c = ctx.context || {};
    const outSize = fs.existsSync(s.outPath) ? fs.statSync(s.outPath).size : 0;
    console.log(
        `[${label}] context: readStart=${c.readStart} writeStart=${c.writeStart} ` +
        `readItemCount=${c.readItemCount} blocks=${c.blockStarts ? c.blockStarts.length / 8 : 0} outSize=${outSize}`
    );
    if (c.readStart === undefined) return c;

    expect(c.completed).toBeUndefined();
    expect(c.data ? c.data.length : 0).toBe(0);
    // 未提交的在途写入可能已落盘，outSize ≥ writeStart；续传从 writeStart 覆盖
    expect(c.writeStart).toBeLessThanOrEqual(outSize);
    // 输入按整 item 提交，每个满 item 的密封大小固定
    expect(c.readStart % MaxItemSize).toBe(0);
    expect(c.readItemCount).toBe(c.readStart / MaxItemSize);
    expect(c.writeStart).toBe(c.readItemCount * s.sealedItemSize);
    expect(c.blockStarts.length).toBe(8 * Math.ceil(c.readItemCount / 256));
    expect(c.dataHash.length).toBe(32);
    expect(c.source).toEqual({ size: PLAIN_SIZE, mtimeMs: fs.statSync(s.srcPath).mtimeMs });
    return c;
}

function writeConfig(s, extra) {
    fs.writeFileSync(
        s.configPath,
        JSON.stringify({
            srcPath: s.srcPath,
            outPath: s.outPath,
            contextPath: s.contextPath,
            privateKey: key_pair.private_key,
            publicKey: key_pair.public_key,
            ...extra,
        })
    );
}

/** 父进程最终续传并校验结果 */
async function finalResumeAndVerify(label, s, { transcodeLike, contextOptions, writeStreamOptions } = {}) {
    const context = new PipelineContextInFile(s.contextPath, contextOptions || {});
    await context.loadContext({ sourcePath: s.srcPath, outputPath: s.outPath });
    const resumedFrom = context.context.readItemCount || 0;
    const rs = transcodeLike
        ? fs.createReadStream(s.srcPath, { highWaterMark: 100000 })
        : new RecoverableSourceStream(s.srcPath, context);
    const sealer = new Sealer({ keyPair: key_pair, context, skipCommittedInput: !!transcodeLike });
    const ws = new RecoverableWriteStream(s.outPath, context, writeStreamOptions);
    await new Promise((resolve, reject) => {
        for (const st of [rs, sealer, ws]) {
            st.on('error', (err) => reject(new Error(`[${label}] final resume error: ${err.message}`)));
        }
        rs.pipe(sealer).pipe(ws);
        ws.on('finish', resolve);
    });

    expect(fs.statSync(s.outPath).size).toBe(s.refSize);
    expect(dataHashOfSealedFile(s.outPath).equals(s.refHash)).toBe(true);
    expect(sealer.dataHash.equals(s.refHash)).toBe(true);
    expect(readTail(s.outPath).header.item_number).toBe(s.refItems);
    expect(await calculateMD5(s.srcPath)).toBe(s.plainMd5);

    const ret = s.outPath + '.ret';
    await pipeline(new SealedFileStream(s.outPath), new Unsealer({ keyPair: key_pair }), fs.createWriteStream(ret));
    const md5 = await calculateMD5(ret);
    fs.unlinkSync(ret);
    return { md5, resumedFrom };
}

async function runKillResumeScenario(label, s, { killPoints, contextOptions, writeStreamOptions, transcodeLike }) {
    let checkpoints = 0;
    for (let round = 0; round < killPoints.length; round++) {
        writeConfig(s, {
            mode: 'kill',
            midSealedBytes: killPoints[round],
            transcodeLike,
            contextOptions,
            writeStreamOptions,
        });
        const { child, events } = spawnWorker(s.configPath);
        try {
            await waitForWorkerEvent(events, 'started', 60_000);
            const hit = await waitForWorkerEvent(events, ['mid-seal', 'completed'], 120_000);
            if (hit.event === 'completed') {
                console.log(`[${label}] round ${round}: completed before kill point, stopping kills`);
                await signalAndWait(child, 'SIGKILL');
                break;
            }
            await sleep(KILL_DELAY_MS);
            await signalAndWait(child, 'SIGKILL');
            console.log(`[${label}] round ${round}: SIGKILL at sealedBytes>=${hit.bytes}`);
            const c = await loadAndAssertSealCheckpoint(`${label} after-kill-${round}`, s);
            if (c.readStart !== undefined) checkpoints++;
        } catch (e) {
            await signalAndWait(child, 'SIGKILL');
            throw new Error(`[${label}] round ${round} failed: ${e.message}`);
        }
    }
    expect(checkpoints).toBeGreaterThan(0);

    const { md5, resumedFrom } = await finalResumeAndVerify(label, s, { transcodeLike, contextOptions, writeStreamOptions });
    expect(resumedFrom).toBeGreaterThan(0);
    return md5;
}

async function prepareScenario(name) {
    const dir = testPath(`${name}_seal`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const srcPath = path.join(dir, 'plain.file');
    generateRandomFile(srcPath, PLAIN_SIZE);
    const ref = path.join(dir, 'ref.sealed');
    await pipeline(fs.createReadStream(srcPath), new Sealer({ keyPair: key_pair }), fs.createWriteStream(ref));
    const { header, firstBlock } = readTail(ref);
    const s = {
        srcPath,
        plainMd5: await calculateMD5(srcPath),
        refSize: fs.statSync(ref).size,
        refHash: dataHashOfSealedFile(ref),
        refItems: header.item_number,
        sealedItemSize: firstBlock.end_file_pos / firstBlock.end_item_index,
        outPath: path.join(dir, 'out.sealed'),
        contextPath: path.join(dir, 'out.sealed.progress'),
        configPath: path.join(dir, 'worker.json'),
    };
    fs.unlinkSync(ref);
    return s;
}

beforeAll(() => {
    if (!fs.existsSync(buildEntry)) {
        throw new Error('build/commonjs/index.node.cjs missing; run `npm run build` first');
    }
});

test('seal sigkill x2 then resume - defaults (saveFrequency=32, inflight 4MiB)', async () => {
    const s = await prepareScenario('seal_default');
    const md5 = await runKillResumeScenario('seal-default', s, {
        killPoints: [2 * MiB, 8 * MiB],
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

test('seal sigkill x2 then resume - unbounded inflight (writer never applies backpressure)', async () => {
    const s = await prepareScenario('seal_unbounded');
    const md5 = await runKillResumeScenario('seal-unbounded', s, {
        killPoints: [3 * MiB, 20 * MiB],
        writeStreamOptions: { maxInflightBytes: 2 * PLAIN_SIZE },
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

test('seal sigkill x2 then resume - maxInflightBytes=1 (every write blocks on the waiter)', async () => {
    const s = await prepareScenario('seal_blocking');
    const md5 = await runKillResumeScenario('seal-blocking', s, {
        killPoints: [1 * MiB, 6 * MiB],
        writeStreamOptions: { maxInflightBytes: 1 },
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

test('seal sigkill x4 then resume - minSaveIntervalMs=200 widens checkpoint gaps', async () => {
    const s = await prepareScenario('seal_multi');
    const md5 = await runKillResumeScenario('seal-multi', s, {
        killPoints: [1 * MiB, 5 * MiB, 12 * MiB, 30 * MiB],
        contextOptions: { saveFrequency: 8, minSaveIntervalMs: 200 },
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 600000);

test('seal sigkill x2 then resume - transcode path (input from start + skipCommittedInput)', async () => {
    const s = await prepareScenario('seal_transcode');
    const md5 = await runKillResumeScenario('seal-transcode', s, {
        killPoints: [2 * MiB, 10 * MiB],
        transcodeLike: true,
    });
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

test('seal graceful cross-process (SIGTERM → pause) then resume', async () => {
    const s = await prepareScenario('seal_graceful');
    writeConfig(s, { mode: 'graceful', midSealedBytes: 4 * MiB });
    const { child, events } = spawnWorker(s.configPath);
    try {
        await waitForWorkerEvent(events, 'started', 60_000);
        await waitForWorkerEvent(events, 'mid-seal', 120_000);
        child.kill('SIGTERM');
        await waitForWorkerEvent(events, 'graceful-exit', 60_000);
    } finally {
        await signalAndWait(child, 'SIGKILL');
    }
    const c = await loadAndAssertSealCheckpoint('seal-graceful after-pause', s);
    expect(c.readStart).toBeGreaterThan(0);

    const { md5, resumedFrom } = await finalResumeAndVerify('seal-graceful', s);
    expect(resumedFrom).toBe(c.readItemCount);
    expect(md5).toStrictEqual(s.plainMd5);
}, 300000);

import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import log from 'loglevel';
import { Sealer } from '../src/node/Sealer';
import { Unsealer } from '../src/node/Unsealer';
import { SealedFileStream } from '../src/node/SealedFileStream';
import { PipelineContextInFile } from '../src/node/PipelineConext.js';
import { RecoverableSourceStream, RecoverableWriteStream } from '../src/node/Recoverable.js';
import { dataHashOfSealedFile } from '../src/node/SealedFileUtil.js';
import { buffer2header_t } from '../src/common/header_util.js';
import { HeaderSize, MaxItemSize } from '../src/common/limits.js';
import { calculateMD5, key_pair, testPath } from './helper';

log.setLevel('error');

function writeRandomFile(p, size) {
    fs.writeFileSync(p, crypto.randomBytes(size));
}

function cleanup(...paths) {
    for (const p of paths) {
        for (const f of [p, p + '.tmp']) {
            try { fs.unlinkSync(f); } catch (e) {}
        }
    }
}

function readHeader(sealedPath) {
    const buf = fs.readFileSync(sealedPath);
    return buffer2header_t(buf.subarray(buf.length - HeaderSize));
}

async function sealPlain(src, dst, highWaterMark) {
    await pipeline(
        fs.createReadStream(src, { highWaterMark }),
        new Sealer({ keyPair: key_pair }),
        fs.createWriteStream(dst),
    );
}

async function unsealTo(sealed, out) {
    await pipeline(
        new SealedFileStream(sealed),
        new Unsealer({ keyPair: key_pair }),
        fs.createWriteStream(out),
    );
}

/**
 * 加密续传管道：RecoverableSourceStream → Sealer({context}) → RecoverableWriteStream。
 * transcodeLike：模拟 dsft 的转码路径，输入从源头开始（且分片大小不对齐），由 Sealer 跳过已封装部分。
 * stop：'hard' 直接销毁全部流（不走 _final）；'pause' 断管道后 end 写端（README 标准暂停）。
 */
async function runSeal(src, out, progressPath, { stopAfterWritten, stop = 'hard', transcodeLike = false, ctxOptions } = {}) {
    const context = new PipelineContextInFile(progressPath, { saveFrequency: 4, ...ctxOptions });
    await context.loadContext({ sourcePath: src, outputPath: out });
    const rs = transcodeLike
        ? fs.createReadStream(src, { highWaterMark: 100000 })
        : new RecoverableSourceStream(src, context);
    const progress = [];
    const sealer = new Sealer({
        keyPair: key_pair,
        context,
        skipCommittedInput: transcodeLike,
        progressHandler: (total, items, bytes, written) => progress.push({ items, bytes, written }),
    });
    const ws = new RecoverableWriteStream(out, context);

    const stopped = await new Promise((resolve, reject) => {
        let settled = false;
        const onError = (err) => {
            if (settled || (err && err.code === 'ERR_STREAM_PREMATURE_CLOSE')) return;
            settled = true;
            reject(err);
        };
        for (const s of [rs, sealer, ws]) s.on('error', onError);
        ws.on('finish', () => {
            if (settled) return;
            settled = true;
            resolve(false);
        });
        if (stopAfterWritten) {
            const poll = setInterval(() => {
                if ((context.context.writeStart || 0) < stopAfterWritten) return;
                clearInterval(poll);
                if (settled) return;
                settled = true;
                rs.unpipe(sealer);
                sealer.unpipe(ws);
                rs.destroy();
                sealer.destroy();
                if (stop === 'hard') {
                    ws.destroy();
                    setTimeout(() => context._saveTail.then(() => resolve(true), reject), 50);
                } else {
                    ws.end((err) => (err ? reject(err) : resolve(true)));
                }
            }, 2);
        }
        rs.pipe(sealer).pipe(ws);
    });
    await context._saveTail;
    return { stopped, sealer, context, progress };
}

async function loadProgress(progressPath) {
    const ctx = new PipelineContextInFile(progressPath);
    await ctx.loadContext();
    return ctx.context;
}

test('Sealer cuts fixed 64 KiB items regardless of upstream chunk size', async () => {
    const src = testPath('seal_fixed_items.file');
    const a = src + '.a.sealed';
    const b = src + '.b.sealed';
    cleanup(src, a, b);
    const size = 3 * 1024 * 1024 + 12345;
    writeRandomFile(src, size);

    await sealPlain(src, a, 1024 * 1024);
    await sealPlain(src, b, 10000);

    const ha = readHeader(a);
    const hb = readHeader(b);
    expect(ha.item_number).toBe(Math.ceil(size / MaxItemSize));
    expect(hb.item_number).toBe(ha.item_number);
    expect(ha.data_hash.equals(hb.data_hash)).toBe(true);

    const out = src + '.ret';
    await unsealTo(a, out);
    expect(await calculateMD5(out)).toBe(await calculateMD5(src));
    cleanup(src, a, b, out);
});

test.each([
    ['hard stop, source stream', 'hard', false],
    ['graceful pause, source stream', 'pause', false],
    ['hard stop, input from start (transcode path)', 'hard', true],
    ['graceful pause, input from start (transcode path)', 'pause', true],
])('seal resumes after %s', async (_label, stop, transcodeLike) => {
    const tag = `${stop}_${transcodeLike ? 'skip' : 'seek'}`;
    const src = testPath(`seal_resume_${tag}.file`);
    const out = src + '.sealed';
    const progressPath = out + '.progress';
    const ref = src + '.ref.sealed';
    const ret = src + '.ret';
    cleanup(src, out, progressPath, ref, ret);
    // 跨越多个 block（256 item/block），且末尾是不满 64 KiB 的 item
    const size = 40 * 1024 * 1024 + 777;
    writeRandomFile(src, size);
    await sealPlain(src, ref, 1024 * 1024);

    const first = await runSeal(src, out, progressPath, { stopAfterWritten: 18 * 1024 * 1024, stop, transcodeLike });
    expect(first.stopped).toBe(true);
    const saved = await loadProgress(progressPath);
    expect(saved.completed).toBeUndefined();
    expect(saved.readStart % MaxItemSize).toBe(0);
    expect(saved.readItemCount).toBe(saved.readStart / MaxItemSize);
    expect(saved.readStart).toBeGreaterThan(0);
    expect(fs.statSync(out).size).toBeGreaterThanOrEqual(saved.writeStart);

    const second = await runSeal(src, out, progressPath, { transcodeLike });
    expect(second.stopped).toBe(false);

    const refHash = dataHashOfSealedFile(ref);
    expect(dataHashOfSealedFile(out).equals(refHash)).toBe(true);
    expect(second.sealer.dataHash.equals(refHash)).toBe(true);
    expect(readHeader(out).item_number).toBe(readHeader(ref).item_number);
    expect(fs.statSync(out).size).toBe(fs.statSync(ref).size);

    const firstProgress = second.progress[0];
    expect(firstProgress.items).toBe(saved.readItemCount + 1);
    const last = second.progress[second.progress.length - 1];
    expect(last.bytes).toBe(size);
    expect(last.written).toBe(fs.statSync(out).size);

    expect((await loadProgress(progressPath)).completed).toBe(true);

    await unsealTo(out, ret);
    expect(await calculateMD5(ret)).toBe(await calculateMD5(src));
    cleanup(src, out, progressPath, ref, ret);
}, 120000);

test('seal restarts from scratch when the source changed', async () => {
    const src = testPath('seal_resume_changed.file');
    const out = src + '.sealed';
    const progressPath = out + '.progress';
    const ref = src + '.ref.sealed';
    const ret = src + '.ret';
    cleanup(src, out, progressPath, ref, ret);
    writeRandomFile(src, 20 * 1024 * 1024);

    const first = await runSeal(src, out, progressPath, { stopAfterWritten: 6 * 1024 * 1024 });
    expect(first.stopped).toBe(true);

    fs.appendFileSync(src, crypto.randomBytes(4096));
    await sealPlain(src, ref, 1024 * 1024);

    const second = await runSeal(src, out, progressPath);
    expect(second.progress[0].items).toBe(1);
    expect(dataHashOfSealedFile(out).equals(dataHashOfSealedFile(ref))).toBe(true);
    await unsealTo(out, ret);
    expect(await calculateMD5(ret)).toBe(await calculateMD5(src));
    cleanup(src, out, progressPath, ref, ret);
}, 60000);

test('seal resumes from a checkpoint taken after the last item but before the tail', async () => {
    const src = testPath('seal_resume_pre_tail.file');
    const out = src + '.sealed';
    const progressPath = out + '.progress';
    const snapshot = progressPath + '.snap';
    const ref = src + '.ref.sealed';
    const ret = src + '.ret';
    cleanup(src, out, progressPath, snapshot, ref, ret);
    // 整数个 item：最后一个 item 在 _transform 中封装，文件尾在 _flush 中单独提交
    const size = 300 * MaxItemSize;
    writeRandomFile(src, size);
    await sealPlain(src, ref, 1024 * 1024);

    // 连续的 saveContext 会合并落盘，这里在调用时直接留下该时刻的快照（等价于它落盘后进程被杀）
    const original = PipelineContextInFile.prototype.saveContext;
    PipelineContextInFile.prototype.saveContext = function () {
        if (this.context.completed !== true && this.context.readStart === size) {
            fs.writeFileSync(snapshot, this._buildPayload());
        }
        return original.call(this);
    };
    try {
        await runSeal(src, out, progressPath, { ctxOptions: { saveFrequency: 1 } });
    } finally {
        PipelineContextInFile.prototype.saveContext = original;
    }
    expect(fs.existsSync(snapshot)).toBe(true);
    fs.copyFileSync(snapshot, progressPath);

    const second = await runSeal(src, out, progressPath);
    expect(second.progress.length).toBe(1);
    expect(dataHashOfSealedFile(out).equals(dataHashOfSealedFile(ref))).toBe(true);
    expect(fs.statSync(out).size).toBe(fs.statSync(ref).size);
    await unsealTo(out, ret);
    expect(await calculateMD5(ret)).toBe(await calculateMD5(src));
    cleanup(src, out, progressPath, snapshot, ref, ret);
}, 60000);

test('re-running a completed seal is a no-op', async () => {
    const src = testPath('seal_resume_completed.file');
    const out = src + '.sealed';
    const progressPath = out + '.progress';
    cleanup(src, out, progressPath);
    writeRandomFile(src, 2 * 1024 * 1024 + 5);

    await runSeal(src, out, progressPath);
    const md5 = await calculateMD5(out);
    const again = await runSeal(src, out, progressPath);
    expect(again.progress.length).toBe(0);
    expect(await calculateMD5(out)).toBe(md5);
    cleanup(src, out, progressPath);
});

test('completed persisted but truncate interrupted: re-run truncates the stale tail', async () => {
    const src = testPath('seal_resume_truncate.file');
    const out = src + '.sealed';
    const progressPath = out + '.progress';
    cleanup(src, out, progressPath);
    writeRandomFile(src, 3 * 1024 * 1024 + 99);

    await runSeal(src, out, progressPath);
    const size = fs.statSync(out).size;
    const md5 = await calculateMD5(out);
    fs.appendFileSync(out, crypto.randomBytes(5000));

    const again = await runSeal(src, out, progressPath);
    expect(again.progress.length).toBe(0);
    expect(fs.statSync(out).size).toBe(size);
    expect(await calculateMD5(out)).toBe(md5);
    cleanup(src, out, progressPath);
});

test('loadContext rejects sealing in place', async () => {
    const src = testPath('seal_resume_inplace.file');
    cleanup(src, src + '.progress');
    writeRandomFile(src, 1024);
    const context = new PipelineContextInFile(src + '.progress');
    await expect(context.loadContext({ sourcePath: src, outputPath: src }))
        .rejects.toMatchObject({ code: 'ERR_SEAL_INPLACE_UNSUPPORTED' });
    cleanup(src);
});

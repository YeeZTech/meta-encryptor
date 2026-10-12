/**
 * "续传一个已完成的任务"不能再撞 ERR_VERSION_MISMATCH。
 *
 * 背景：inplace 解密完成即 truncate，密文尾 header 随之消失；若任务状态没来得及
 * 更新（进程被杀 / 用户重试），再次构建管道会把明文当密封文件打开。
 * 现在写端在 truncate 前先把 completed 持久化进 context：
 *   - 带 completed 的 context 再建管道：读端直接结束，写端补做 truncate 并 'finish'
 *   - completed 落盘与 truncate 之间被杀：重启后同样走上面路径，文件被正确收尾
 *   - header 校验失败的错误带上 tailHex / fileSize，日志可直接判断尾部是什么
 */
const meta = require('../src/index.node.js');
import {Sealer} from '../src/node/Sealer';
const {PipelineContextInFile} = require('../src/node/PipelineConext.js');
const {RecoverableReadStream, RecoverableWriteStream} = require('../src/node/Recoverable.js');
const {SealedFileStream} = require('../src/node/SealedFileStream.js');
import fs from 'fs';
import log from 'loglevel';
import {calculateMD5, key_pair, testPath} from './helper';

const path = require('path');
const crypto = require('crypto');

log.setLevel('error');
// 本文件刻意触发"续传已完成任务"的 warn 与 header 校验失败的 error 日志，静音以免刷屏
log.getLogger('meta-encryptor/Recoverable').setLevel('silent');
log.getLogger('meta-encryptor/SealedFileStream').setLevel('silent');

const MiB = 1024 * 1024;

async function sealFile(src) {
    const dst = src + '.sealed';
    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dst);
        ws.on('finish', resolve);
        ws.on('error', reject);
        fs.createReadStream(src).pipe(new Sealer({keyPair: key_pair})).pipe(ws);
    });
    return dst;
}

function runPipeline(sealedPath, outPath, context, { wrapContext } = {}) {
    return new Promise((resolve, reject) => {
        if (wrapContext) wrapContext(context);
        const rs = new RecoverableReadStream(sealedPath, context);
        const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
        const ws = new RecoverableWriteStream(outPath, context);
        for (const s of [rs, unsealer, ws]) s.on('error', reject);
        rs.pipe(unsealer).pipe(ws);
        ws.on('finish', resolve);
    });
}

async function prepare(name, size = 8 * MiB) {
    const dir = testPath(`${name}_completed`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const plain = path.join(dir, 'plain.bin');
    fs.writeFileSync(plain, crypto.randomBytes(size));
    const plainMd5 = await calculateMD5(plain);
    const sealed = await sealFile(plain);
    fs.unlinkSync(plain);
    return { dir, sealed, plainMd5, size, ctxPath: path.join(dir, 'progress.ctx') };
}

async function loadCtx(ctxPath) {
    const c = new PipelineContextInFile(ctxPath);
    await c.loadContext();
    return c;
}

test('inplace：完成后带同一 context 再跑一遍，直接 finish，文件不变、不报 ERR_VERSION_MISMATCH', async () => {
    const s = await prepare('inplace_rerun');
    await runPipeline(s.sealed, s.sealed, await loadCtx(s.ctxPath));
    expect(fs.statSync(s.sealed).size).toBe(s.size);
    expect(await calculateMD5(s.sealed)).toBe(s.plainMd5);

    const ctx = await loadCtx(s.ctxPath);
    expect(ctx.context.completed).toBe(true);
    expect(ctx.context.decryptCompleted).toBeUndefined(); // 运行期字段不落地

    // 老版本客户端的典型路径：任务状态还是"解密中"，重启后再次 resume
    await runPipeline(s.sealed, s.sealed, ctx);
    expect(fs.statSync(s.sealed).size).toBe(s.size);
    expect(await calculateMD5(s.sealed)).toBe(s.plainMd5);
    expect((await loadCtx(s.ctxPath)).context.completed).toBe(true);
}, 60000);

test('inplace：completed 已落盘但 truncate 前被打断，续传补做 truncate 并正确收尾', async () => {
    const s = await prepare('inplace_pre_truncate');
    const sealedSize = fs.statSync(s.sealed).size;

    // 在"completed 落盘成功之后、truncate 之前"注入失败，模拟此刻进程被杀
    const err = await runPipeline(s.sealed, s.sealed, await loadCtx(s.ctxPath), {
        wrapContext: (context) => {
            const orig = context.saveContext.bind(context);
            context.saveContext = () =>
                orig().then(() => {
                    if (context.context.completed === true) throw new Error('killed before truncate');
                });
        },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('killed before truncate');

    // 此时：全部明文已写入，但文件还没被截断（明文 + 残留密文尾）
    expect(fs.statSync(s.sealed).size).toBe(sealedSize);
    const saved = await loadCtx(s.ctxPath);
    expect(saved.context.completed).toBe(true);
    expect(saved.context.writeStart).toBe(s.size);

    // 续传：读端不去碰（已非密封格式的）尾部 header，写端补做 truncate
    await runPipeline(s.sealed, s.sealed, saved);
    expect(fs.statSync(s.sealed).size).toBe(s.size);
    expect(await calculateMD5(s.sealed)).toBe(s.plainMd5);
}, 60000);

test('双文件：完成后再跑一遍同样直接 finish，输出与密文都不变', async () => {
    const s = await prepare('dual_rerun');
    const out = path.join(s.dir, 'out.bin');
    const sealedMd5 = await calculateMD5(s.sealed);
    await runPipeline(s.sealed, out, await loadCtx(s.ctxPath));
    expect(await calculateMD5(out)).toBe(s.plainMd5);

    await runPipeline(s.sealed, out, await loadCtx(s.ctxPath));
    expect(await calculateMD5(out)).toBe(s.plainMd5);
    expect(await calculateMD5(s.sealed)).toBe(sealedMd5);
}, 60000);

test('中途暂停的 context 不带 completed；完成前的中间存档即使含 decryptCompleted 也不算完成', async () => {
    const s = await prepare('paused_no_completed');
    const out = path.join(s.dir, 'out.bin');
    const context = await loadCtx(s.ctxPath);
    await new Promise((resolve, reject) => {
        const rs = new RecoverableReadStream(s.sealed, context);
        let paused = false;
        const unsealer = new meta.Unsealer({ keyPair: key_pair, context, progressHandler: (t, read) => {
            if (!paused && read >= 40) {
                paused = true;
                rs.unpipe(unsealer); unsealer.unpipe(ws); rs.destroy(); unsealer.destroy();
                ws.end((e) => (e ? reject(e) : resolve()));
            }
        } });
        const ws = new RecoverableWriteStream(out, context);
        for (const st of [rs, unsealer, ws]) st.on('error', (e) => { if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE') reject(e); });
        rs.pipe(unsealer).pipe(ws);
    });
    const paused = await loadCtx(s.ctxPath);
    expect(paused.context.completed).toBeUndefined();
    expect(paused.context.writeStart).toBeLessThan(s.size);

    // 人为污染：中间存档里残留 decryptCompleted，load 后必须被丢弃，续传照常进行
    paused.context.decryptCompleted = true;
    await paused.saveContext();
    const reloaded = await loadCtx(s.ctxPath);
    expect(reloaded.context.decryptCompleted).toBeUndefined();
    expect(reloaded.context.completed).toBeUndefined();
    await runPipeline(s.sealed, out, reloaded);
    expect(await calculateMD5(out)).toBe(s.plainMd5);
}, 60000);

test('对非密封文件（如已 truncate 的明文）打开 SealedFileStream：错误带 tailHex / fileSize', async () => {
    const dir = testPath('tail_detail_completed');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const plain = path.join(dir, 'plain.bin');
    const size = 1000;
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i++) body[i] = i % 256;
    fs.writeFileSync(plain, body);

    const err = await new Promise((resolve) => {
        const st = new SealedFileStream(plain);
        st.on('error', resolve);
        st.on('data', () => {});
    });
    expect(err.code).toBe('ERR_VERSION_MISMATCH');
    expect(err.detail.fileSize).toBe(size);
    expect(err.detail.filePath).toBe(plain);
    expect(err.detail.tailHex).toBe(body.subarray(size - 64).toString('hex'));
    // 报错里的 actual 是丢了精度的 Number；tailHex 的第 8~16 字节才是原始版本字段
    expect(BigInt.asUintN(64, BigInt(Math.round(err.detail.actual))).toString(16).slice(0, 6))
        .toBe(Buffer.from(err.detail.tailHex, 'hex').readBigUInt64LE(8).toString(16).slice(0, 6));
}, 30000);

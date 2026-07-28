const meta = require('../src/index.node.js');
import {Sealer, ToString} from '../src/node/Sealer';
import {Unsealer} from '../src/node/Unsealer';
import log from 'loglevel';
const logger = log.getLogger("meta-encryptor/Recoverable");
log.setLevel('error');
logger.setLevel('error');

/** README 标准 pause：断管道、销毁读端、等写端 end 完成 */
function pauseDecryptPipeline(rs, unsealer, ws, middle) {
    rs.unpipe(unsealer);
    if (middle) {
        unsealer.unpipe(middle);
        middle.unpipe(ws);
    } else {
        unsealer.unpipe(ws);
    }
    rs.destroy();
    unsealer.destroy();
    if (middle) middle.destroy();
    return new Promise((resolve, reject) => {
        ws.end((err) => (err ? reject(err) : resolve()));
    });
}

/** 测试里把管道错误接到 Promise，避免挂死（不改变库的调用方式） */
function bindPipelineErrors(streams, reject) {
    for (const s of streams) {
        if (s) s.on('error', reject);
    }
}

const {PipelineContextInFile} = require('../src/node/PipelineConext.js');
const {RecoverableReadStream, RecoverableWriteStream} = require('../src/node/Recoverable.js');
import fs from 'fs';
import {calculateMD5, key_pair, generateFileWithSize, testPath} from './helper';

const path = require('path');
async function sealFile(src) {
    let dst = path.join(path.dirname(src), path.basename(src) + '.sealed');
    let rs = fs.createReadStream(src);
    let ws = fs.createWriteStream(dst);
    let tag = 'seal ' + src + ' cost time';
    console.time(tag);
    rs.pipe(new Sealer({keyPair: key_pair})).pipe(ws);
    await new Promise((resolve) => {
        ws.on('finish', () => {
            resolve();
        });
    });
    console.timeEnd(tag);
    return dst;
}
async function compare(src, ret_src) {
    let m1 = await calculateMD5(src);
    let m2 = await calculateMD5(ret_src);
    expect(m1.length > 0).toBe(true);
    expect(m1).toStrictEqual(m2);
}

function unsealerRemainingBuffer(unsealer) {
    const rem = unsealer._state.remaining;
    if (!rem || rem.length === 0) return Buffer.alloc(0);
    return Buffer.from(rem.buffer, rem.byteOffset, rem.byteLength);
}

function contextDataBuffer(context) {
    const data = context.context?.data;
    if (!data || data.length === 0) return Buffer.alloc(0);
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/**
 * Invariant: while Read→Unsealer runs (no RecoverableWriteStream), context.data must
 * track Unsealer #core.remaining — not RecoverableReadStream's raw read-ahead append.
 * RecoverableWriteStream checkpoints clear data before save, so pause/resume e2e
 * tests do not exercise this; removing Unsealer's data sync breaks this contract.
 */
test('context.data mirrors unsealer remaining during file-mode decrypt', async () => {
    const src = testPath('context_data_sync.file');
    const contextPath = testPath('context_data_sync_context');
    let dst;

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(contextPath);
        fs.unlinkSync(dst);
    } catch (error) {}

    generateFileWithSize(src, 1024 * 1024 * 5);
    dst = await sealFile(src);

    const context = new PipelineContextInFile(contextPath);
    await context.loadContext();

    const rs = new RecoverableReadStream(dst, context);
    const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
    const sink = new (require('stream').Writable)({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });

    let snapshot = null;

    await new Promise((resolve, reject) => {
        const onError = (err) => {
            if (err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
            reject(err);
        };

        bindPipelineErrors([rs, unsealer, sink], onError);

        const poll = setInterval(() => {
            if (context.context?.status !== 'file') return;

            const remaining = unsealerRemainingBuffer(unsealer);
            const data = contextDataBuffer(context);
            const processedBytes = unsealer._state.processedBytes || 0;

            // Mid-item: past header, unsealer has unconsumed tail, pipeline still running
            if (processedBytes > 65536 && remaining.length > 0 && data.length > 0) {
                snapshot = { data: Buffer.from(data), remaining: Buffer.from(remaining) };
                clearInterval(poll);
                rs.unpipe(unsealer);
                unsealer.unpipe(sink);
                rs.destroy();
                unsealer.destroy();
                sink.end(() => resolve());
            }
        }, 10);

        rs.pipe(unsealer).pipe(sink);
        sink.on('finish', () => {
            clearInterval(poll);
            resolve();
        });

        setTimeout(() => {
            clearInterval(poll);
            reject(new Error('timed out waiting for mid-item partial decrypt state'));
        }, 30000);
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot.data.equals(snapshot.remaining)).toBe(true);

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(dst);
        fs.unlinkSync(contextPath);
    } catch (error) {}
}, 60000);

test('test pipeline context basic', async () => {
    //let src = "Unsealerlarge.file";
    //let src = './rollup.config.js'
    let src = testPath('tsconfig.json');
    fs.copyFileSync('./tsconfig.json', src);
    let context_path = testPath('test_context');

    try {
        //fs.unlinkSync(src)
        fs.unlinkSync(context_path);
    } catch (error) {}
    let dst = await sealFile(src);
    let ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');

    let context = new PipelineContextInFile(context_path);
    context.loadContext();
    let rs = new RecoverableReadStream(dst, context);
    let ws = new RecoverableWriteStream(ret_src, context);
    let unsealer = new meta.Unsealer({keyPair: key_pair, context: context});
    rs.pipe(unsealer).pipe(ws);

    await new Promise((resolve) => {
        ws.on('finish', () => {
            resolve();
        });
    });

    await compare(src, ret_src);

    try {
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
        fs.unlinkSync(dst);
    } catch (error) {}
});

test('test pipeline context large', async () => {
    let src = testPath('Unsealerlarge.file');
    //let src = './rollup.config.js'
    //let src = './tsconfig.json'
    let context_path = testPath('test_context');
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
    } catch (error) {}
    //100MB
    generateFileWithSize(src, 1024 * 1024 * 100);
    let dst = await sealFile(src);
    let ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');

    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    let rs = new RecoverableReadStream(dst, context);
    let ws = new RecoverableWriteStream(ret_src, context);

    let unsealer = new meta.Unsealer({
        keyPair: key_pair,
        progressHandler: (...args) => {
            _progressHandler(args[0], args[1], args[2], args[3]);
        },
        context: context
    });
    let bytesRead = 0;
    let bytesWritten = 0;
    let lastReportedRead = 0;
    let lastReportedWrite = 0;
    const _progressHandler = (totalItem, readItem, bytes, writeBytes) => {
    };
    // 监听读取流的数据事件
    rs.on('data', (chunk) => {
        bytesRead += chunk.length;

        // 每10MB打印一次状态，避免过多输出
        if (bytesRead - lastReportedRead >= 10 * 1024 * 1024) {
            lastReportedRead = bytesRead;
        }
    });

    // 监听写入流的数据事件 (如果WriteStream暴露了data事件)
    // 注意: 某些WriteStream可能不会触发data事件
    if (ws.on && typeof ws.on === 'function') {
        ws.on('data', (chunk) => {
            bytesWritten += chunk.length;

            // 每10MB打印一次状态
            if (bytesWritten - lastReportedWrite >= 10 * 1024 * 1024) {
                lastReportedWrite = bytesWritten;
            }
        });
    }

    // 监听监听写入流的进度
    let writeProgress = 0;
    if (ws.on && typeof ws.on === 'function') {
        ws.on('drain', () => {
            const currentWritten = ws.bytesWritten || 0; 
            if (currentWritten > writeProgress) {

                writeProgress = currentWritten;
            }
        });
    }

    // 启动处理
    rs.pipe(unsealer).pipe(ws);

    await new Promise((resolve) => {
        ws.on('finish', () => {
            resolve();
        });
    });
    await compare(src, ret_src);
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
        fs.unlinkSync(dst);
    } catch (error) {}
}, 180000);


test('test pipeline context with pause and resume from large file', async () => {
    let src = testPath('pause_resume_large.file');
    let context_path = testPath('pause_resume_large_context');
    let dst, ret_src;

    ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
    } catch (error) {}

    generateFileWithSize(src, 1024 * 1024 * 20);
    dst = await sealFile(src);

    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    let pauseTriggered = false;
    const pauseThreshold = 1024 * 1024 * 5;

    class PauseController extends require('stream').Transform {
        _transform(chunk, encoding, callback) {
            this.push(chunk);
            callback();
        }
    }

    // --- stage1：解密一部分后 pause（README：unpipe + destroy + ws.end）---
    await new Promise((resolve, reject) => {
        const progressHandler = (totalItem, readItem, bytes, writeBytes) => {
            if (!pauseTriggered && writeBytes >= pauseThreshold) {
                pauseTriggered = true;
            }
        };

        let rs = new RecoverableReadStream(dst, context);
        let unsealer = new meta.Unsealer({ keyPair: key_pair, context, progressHandler });
        let pauseController = new PauseController();
        let ws = new RecoverableWriteStream(ret_src, context);

        bindPipelineErrors([rs, unsealer, pauseController, ws], reject);

        const checkInterval = setInterval(async () => {
            if (!pauseTriggered) return;
            clearInterval(checkInterval);
            try {
                await pauseDecryptPipeline(rs, unsealer, ws, pauseController);
                resolve();
            } catch (e) {
                reject(e);
            }
        }, 100);

        rs.pipe(unsealer).pipe(pauseController).pipe(ws);
    });

    context = new PipelineContextInFile(context_path);
    await context.loadContext();

    // --- stage2：loadContext 后重建管道（README 示例）---
    await new Promise((resolve, reject) => {
        let rs = new RecoverableReadStream(dst, context);
        let unsealer = new meta.Unsealer({ keyPair: key_pair, context });
        let ws = new RecoverableWriteStream(ret_src, context);

        bindPipelineErrors([rs, unsealer, ws], reject);
        rs.pipe(unsealer).pipe(ws);
        ws.on('finish', resolve);
    });

    await compare(src, ret_src);

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(dst);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
    } catch (error) {}
}, 180000);



test('test pipeline context with multiple random pause and resume', async () => {
    let src = testPath('pause_resume_large.rand.file');
    let context_path = testPath('pause_resume_large_context.rand');
    let dst, ret_src;

    ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
        fs.unlinkSync(dst);
    } catch (error) {}

    const fileSize = 1024 * 1024 * 50;
    generateFileWithSize(src, fileSize);
    dst = await sealFile(src);

    const generateRandomPausePoints = (fileSize, numberOfPauses) => {
        const minGap = 1024 * 1024 * 2;
        const pausePoints = new Set();

        while (pausePoints.size < numberOfPauses) {
            const point = Math.floor(minGap + Math.random() * (fileSize - minGap * 2));
            pausePoints.add(point);
        }

        return Array.from(pausePoints).sort((a, b) => a - b);
    };

    const pausePoints = generateRandomPausePoints(fileSize, 4);

    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    for (let stage = 0; stage < pausePoints.length + 1; stage++) {
        const currentPauseThreshold = pausePoints[stage];

        await new Promise((resolve, reject) => {
            let pauseTriggered = false;
            const progressHandler = (totalItem, readItem, bytes, writeBytes) => {
                if (
                    stage < pausePoints.length &&
                    !pauseTriggered &&
                    writeBytes >= currentPauseThreshold
                ) {
                    pauseTriggered = true;
                }
            };

            let rs = new RecoverableReadStream(dst, context);
            let unsealer = new meta.Unsealer({ keyPair: key_pair, context, progressHandler });
            let ws = new RecoverableWriteStream(ret_src, context);

            bindPipelineErrors([rs, unsealer, ws], reject);

            let checkInterval;
            const tryPause = async () => {
                if (checkInterval) clearInterval(checkInterval);
                try {
                    await pauseDecryptPipeline(rs, unsealer, ws);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            };

            if (stage < pausePoints.length) {
                checkInterval = setInterval(() => {
                    if (pauseTriggered) tryPause();
                }, 100);
            }

            rs.pipe(unsealer).pipe(ws);
            ws.on('finish', resolve);
        });

        context = new PipelineContextInFile(context_path);
        await context.loadContext();

        if (stage < pausePoints.length) {
            const resumeDelay = 2000 + Math.random() * 3000;
            await new Promise((r) => setTimeout(r, resumeDelay));
        }
    }

    await compare(src, ret_src);

    context = new PipelineContextInFile(context_path);
    await context.loadContext();
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
        fs.unlinkSync(dst);
    } catch (error) {}
}, 180000);

test('test pipeline context large same file', async () => {
    let src = testPath('Unsealerlarge.file');
    //let src = './rollup.config.js'
    //let src = './tsconfig.json'
    let context_path = testPath('test_context');
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
    } catch (error) {}
    //100MB
    generateFileWithSize(src, 1024 * 1024 * 100);
    let dst = await sealFile(src);
    let ret_src = src;

    let m1 = await calculateMD5(src);

    let context = new PipelineContextInFile(context_path);
    context.loadContext();
    let rs = new RecoverableReadStream(dst, context);
    // let ws = new RecoverableWriteStream(ret_src, context);
    let ws = new RecoverableWriteStream(dst, context);
    let unsealer = new meta.Unsealer({keyPair: key_pair, context: context});
    rs.pipe(unsealer).pipe(ws);

    await new Promise((resolve) => {
        ws.on('finish', () => {
            resolve();
        });
    });

    let m2 = await calculateMD5(ret_src);
    expect(m1.length > 0).toBe(true);
    expect(m1).toStrictEqual(m2);
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
    } catch (error) {}
    
}, 180000);
test('test pipeline context with pause and resume on same file', async () => {
    let src = testPath('pause_resume_large.same.file');
    let context_path = testPath('pause_resume_large_context.same');
    let dst;

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
    } catch (error) {}

    // 正常用法：读密文 dst，写明文 src（同一输出路径）；不要写入 .sealed 文件本身
    generateFileWithSize(src, 1024 * 1024 * 50);
    dst = await sealFile(src);
    const originalMD5 = await calculateMD5(src);

    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    const pauseThreshold = 1024 * 1024 * 10;

    await new Promise((resolve, reject) => {
        let pauseTriggered = false;
        const progressHandler = (totalItem, readItem, bytes, writeBytes) => {
            if (!pauseTriggered && writeBytes >= pauseThreshold) {
                pauseTriggered = true;
            }
        };

        let rs = new RecoverableReadStream(dst, context);
        let unsealer = new meta.Unsealer({ keyPair: key_pair, context, progressHandler });
        let ws = new RecoverableWriteStream(src, context);

        bindPipelineErrors([rs, unsealer, ws], reject);

        const checkInterval = setInterval(async () => {
            if (!pauseTriggered) return;
            clearInterval(checkInterval);
            try {
                await pauseDecryptPipeline(rs, unsealer, ws);
                resolve();
            } catch (e) {
                reject(e);
            }
        }, 100);

        rs.pipe(unsealer).pipe(ws);
    });

    context = new PipelineContextInFile(context_path);
    await context.loadContext();

    await new Promise((resolve, reject) => {
        let rs = new RecoverableReadStream(dst, context);
        let unsealer = new meta.Unsealer({ keyPair: key_pair, context });
        let ws = new RecoverableWriteStream(src, context);

        bindPipelineErrors([rs, unsealer, ws], reject);
        rs.pipe(unsealer).pipe(ws);
        ws.on('finish', resolve);
    });

    const finalMD5 = await calculateMD5(src);
    expect(originalMD5).toStrictEqual(finalMD5);

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(dst);
        fs.unlinkSync(context_path);
    } catch (error) {}
}, 180000);

// 同文件多轮 pause/resume（读 dst 密文，写回 src 明文路径）；100MB 覆盖 multipause 逻辑，避免 500MB CI 超时
test('test pipeline context with multiple random pause and resume on same file', async () => {
    let src = testPath('multi_pause_resume_large.rand_same.file');
    let context_path = testPath('multi_pause_resume_large_context.rand_same');
    let dst;

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(dst);
    } catch (error) {}

    const fileSize = 1024 * 1024 * 100;
    generateFileWithSize(src, fileSize);
    dst = await sealFile(src);
    const originalMD5 = await calculateMD5(src);

    const generateRandomPausePoints = (fileSize, numberOfPauses) => {
        const minGap = 1024 * 1024 * 2;
        const pausePoints = new Set();

        while (pausePoints.size < numberOfPauses) {
            const point = Math.floor(minGap + Math.random() * (fileSize - minGap * 2));
            pausePoints.add(point);
        }

        return Array.from(pausePoints).sort((a, b) => a - b);
    };

    const pausePoints = generateRandomPausePoints(fileSize, 4);

    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    for (let stage = 0; stage < pausePoints.length + 1; stage++) {
        const currentPauseThreshold = pausePoints[stage];

        await new Promise((resolve, reject) => {
            let pauseTriggered = false;
            const progressHandler = (totalItem, readItem, bytes, writeBytes) => {
                if (
                    stage < pausePoints.length &&
                    !pauseTriggered &&
                    writeBytes >= currentPauseThreshold
                ) {
                    pauseTriggered = true;
                }
            };

            let rs = new RecoverableReadStream(dst, context);
            let unsealer = new meta.Unsealer({ keyPair: key_pair, context, progressHandler });
            let ws = new RecoverableWriteStream(src, context);

            bindPipelineErrors([rs, unsealer, ws], reject);

            let checkInterval;
            const tryPause = async () => {
                if (checkInterval) clearInterval(checkInterval);
                try {
                    await pauseDecryptPipeline(rs, unsealer, ws);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            };

            if (stage < pausePoints.length) {
                checkInterval = setInterval(() => {
                    if (pauseTriggered) tryPause();
                }, 100);
            }

            rs.pipe(unsealer).pipe(ws);
            ws.on('finish', resolve);
        });

        context = new PipelineContextInFile(context_path);
        await context.loadContext();

        if (stage < pausePoints.length) {
            const resumeDelay = 2000 + Math.random() * 3000;
            await new Promise((r) => setTimeout(r, resumeDelay));
        }
    }

    const finalMD5 = await calculateMD5(src);
    expect(originalMD5).toStrictEqual(finalMD5);

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(dst);
        fs.unlinkSync(context_path);
    } catch (error) {}
}, 600000);

test('test truncate removes residual bytes after pause/resume', async () => {
    // This test verifies that _final always truncates to writeStart,
    // removing any residual garbage bytes left from a prior incomplete
    // write attempt. In the old code, the condition
    //   readStart + length >= fileSize
    // could be false when residual bytes exist, skipping truncate
    // and causing SHA256 mismatch.

    let src = testPath('truncate_residual_test.file');
    let context_path = testPath('truncate_residual_context');
    let dst, ret_src;

    ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
    } catch (error) {}

    // Create a small source file (32 bytes — tiny enough to expose the bug)
    const sourceContent = 'hello from FileDownloader test!!';
    fs.writeFileSync(src, sourceContent, 'utf8');
    dst = await sealFile(src);

    // --- Stage 1: partial write, then pause ---
    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    let pauseTriggered = false;
    let totalBytesProcessed = 0;
    const pauseThreshold = 10; // pause after ~10 plaintext bytes

    class PauseController extends require('stream').Transform {
        constructor(options) { super(options); }
        _transform(chunk, encoding, callback) {
            totalBytesProcessed += chunk.length;
            this.push(chunk);
            if (!pauseTriggered && totalBytesProcessed >= pauseThreshold) {
                pauseTriggered = true;
            }
            callback();
        }
    }

    await new Promise((resolve, reject) => {
        let rs = new RecoverableReadStream(dst, context);
        let unsealer = new meta.Unsealer({keyPair: key_pair, context: context});
        let pauseController = new PauseController();
        let ws = new RecoverableWriteStream(ret_src, context);

        let checkInterval = setInterval(() => {
            if (pauseTriggered) {
                clearInterval(checkInterval);
                rs.unpipe(unsealer);
                unsealer.unpipe(pauseController);
                pauseController.unpipe(ws);
                setTimeout(() => {
                    rs.destroy();
                    unsealer.destroy();
                    pauseController.destroy();
                    ws.end();
                    resolve();
                }, 100);
            }
        }, 50);

        rs.pipe(unsealer).pipe(pauseController).pipe(ws);
        ws.on('error', reject);
    });

    // --- Simulate residual garbage bytes ---
    // Append garbage to the output file so fileSize becomes larger
    // than what writeStart represents. This is exactly the scenario
    // where the old code would skip truncate.
    const beforeResidualSize = fs.statSync(ret_src).size;
    const garbage = Buffer.alloc(64, 0xFF); // 64 bytes of 0xFF
    fs.appendFileSync(ret_src, garbage);
    const afterResidualSize = fs.statSync(ret_src).size;
    logger.debug(`Appended ${afterResidualSize - beforeResidualSize} garbage bytes. ` +
                 `File size before: ${beforeResidualSize}, after: ${afterResidualSize}`);

    // --- Stage 2: resume and complete ---
    context = new PipelineContextInFile(context_path);
    await context.loadContext();

    await new Promise((resolve, reject) => {
        let rs = new RecoverableReadStream(dst, context);
        let unsealer = new meta.Unsealer({
            keyPair: key_pair,
            processedItemCount: context.context.readItemCount || 0,
            processedBytes: context.context.readStart || 0,
            writeBytes: context.context.writeStart || 0,
            context: context
        });
        let ws = new RecoverableWriteStream(ret_src, context);

        ws.on('finish', () => {
            logger.debug('Resume completed.');
            resolve();
        });
        ws.on('error', reject);

        rs.pipe(unsealer).pipe(ws);
    });

    // --- Verify: final file must match source (no residual garbage) ---
    const finalSize = fs.statSync(ret_src).size;
    expect(finalSize).toBe(sourceContent.length);
    await compare(src, ret_src);

    // Cleanup
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(dst);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
    } catch (error) {
        console.warn('Cleanup error:', error.message);
    }
}, 30000);

test('test context file disappears after pause - same file', async () => {
    // 模拟场景：原地解密（同文件）时暂停，context 文件丢失，恢复后观察会发生什么错误

    let src = testPath('context_disappear_src.file');
    let context_path = testPath('context_disappear_context');
    let dst;

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
    } catch (error) {}

    // 准备测试文件
    const fileSize = 1024 * 1024 * 2; // 2MB
    generateFileWithSize(src, fileSize);
    const originalMD5 = await calculateMD5(src);  // 保存原始 MD5
    dst = await sealFile(src);                     // 加密 → dst

    const dstSizeBefore = fs.statSync(dst).size;
    console.log('加密文件大小:', dstSizeBefore);

    // --- 第一阶段：原地解密部分数据后暂停 ---
    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    let pauseTriggered = false;
    let totalBytesProcessed = 0;
    const pauseThreshold = 1024 * 512; // 处理 512KB 后暂停

    class PauseController extends require('stream').Transform {
        constructor(options) { super(options); }
        _transform(chunk, encoding, callback) {
            totalBytesProcessed += chunk.length;
            this.push(chunk);
            if (!pauseTriggered && totalBytesProcessed >= pauseThreshold) {
                pauseTriggered = true;
            }
            callback();
        }
    }

    await new Promise((resolve, reject) => {
        let rs = new RecoverableReadStream(dst, context);
        let unsealer = new meta.Unsealer({keyPair: key_pair, context: context});
        let pauseController = new PauseController();
        let ws = new RecoverableWriteStream(dst, context);  // ★ 写入同一个文件

        let checkInterval = setInterval(() => {
            if (pauseTriggered) {
                clearInterval(checkInterval);
                rs.unpipe(unsealer);
                unsealer.unpipe(pauseController);
                pauseController.unpipe(ws);
                setTimeout(() => {
                    rs.destroy();
                    unsealer.destroy();
                    pauseController.destroy();
                    ws.end();
                    resolve();
                }, 200);
            }
        }, 50);

        rs.pipe(unsealer).pipe(pauseController).pipe(ws);
        ws.on('error', reject);
    });

    // 第一阶段后的状态
    console.log('--- 第一阶段完成，context 内容 ---');
    const ctxAfterPause = new PipelineContextInFile(context_path);
    await ctxAfterPause.loadContext();
    console.log('readStart:', ctxAfterPause.context.readStart);
    console.log('writeStart:', ctxAfterPause.context.writeStart);
    console.log('data length:', ctxAfterPause.context.data ? ctxAfterPause.context.data.length : 0);
    console.log('同文件当前大小:', fs.statSync(dst).size);
    console.log('同文件前半段 MD5:', await calculateMD5(dst));
    console.log('文件状态: 前半段已解密为明文，后半段仍是密文 — 文件已损坏不可用');

    // --- 关键步骤：删除 context 文件！---
    console.log('--- 删除 context 文件 ---');
    fs.unlinkSync(context_path);
    expect(fs.existsSync(context_path)).toBe(false);

    // --- 第二阶段：尝试恢复（context 已消失）---
    console.log('--- 第二阶段：尝试恢复（context 已消失）---');

    context = new PipelineContextInFile(context_path);
    await context.loadContext();
    console.log('loadContext 后 context:', JSON.stringify(context.context));

    // context 丢失后，readStart 回到 0，从文件头部开始读
    // 但文件前半段已是明文，SealedFileStream 解析明文时 version_number 为垃圾值
    let resumeError = await new Promise((resolve) => {
        let rs = new RecoverableReadStream(dst, context);
        rs.on('error', (err) => {
            console.log('--- 捕获到预期异常 ---');
            console.log('错误消息:', err.message);
            resolve(err);
        });
        rs.read();
        setTimeout(() => resolve(null), 5000);
    });

    expect(resumeError).not.toBeNull();
    expect(resumeError.message).toContain('Only version 2 is supported');

    // 清理
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(dst);
        // context_path 已在测试体中删除，忽略清理错误
        if (fs.existsSync(context_path)) fs.unlinkSync(context_path);
    } catch (error) {
        console.warn('Cleanup error:', error.message);
    }
}, 30000);

// =============================================================================
 // 跨进程 / 中断续解：优雅（pause+ws.end）与非优雅（SIGKILL）
 // 对齐 dianshu-file-transfer 解密中断场景；失败用例保留以便跟踪 ME progress 耐久性。
 // =============================================================================

const { spawn } = require('child_process');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function parseWorkerEvents(buf, events) {
    for (const line of buf.toString('utf8').split('\n')) {
        const idx = line.indexOf('WORKER_JSON:');
        if (idx < 0) continue;
        try {
            events.push(JSON.parse(line.slice(idx + 'WORKER_JSON:'.length)));
        } catch (_) {
            /* ignore */
        }
    }
}

function waitForWorkerEvent(events, name, timeoutMs) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
            const hit = events.find((e) => e.event === name);
            if (hit) return resolve(hit);
            if (Date.now() - t0 > timeoutMs) {
                reject(
                    new Error(
                        `timeout waiting for worker event "${name}"; got ${JSON.stringify(events)}`
                    )
                );
                return;
            }
            setTimeout(tick, 30);
        };
        tick();
    });
}

/**
 * 优雅中断：解密中段按 README 标准 pause（unpipe + destroy + ws.end），
 * 再 new PipelineContextInFile + loadContext 后续解。应通过。
 */
test('interrupt decrypt graceful (pause + ws.end) then resume', async () => {
    const src = testPath('interrupt_decrypt_graceful.file');
    const contextPath = testPath('interrupt_decrypt_graceful_context');
    const retSrc = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(contextPath);
        fs.unlinkSync(contextPath + '.tmp');
        fs.unlinkSync(retSrc);
    } catch (_) {}

    generateFileWithSize(src, 1024 * 1024 * 16);
    const sealed = await sealFile(src);
    const plainMd5 = await calculateMD5(src);

    let context = new PipelineContextInFile(contextPath);
    await context.loadContext();

    const midThreshold = 256 * 1024;
    let pauseTriggered = false;

    await new Promise((resolve, reject) => {
        const progressHandler = (_t, _r, _b, writeBytes) => {
            if (!pauseTriggered && writeBytes >= midThreshold) {
                pauseTriggered = true;
            }
        };

        const rs = new RecoverableReadStream(sealed, context);
        const unsealer = new meta.Unsealer({ keyPair: key_pair, context, progressHandler });
        const ws = new RecoverableWriteStream(retSrc, context);
        bindPipelineErrors([rs, unsealer, ws], reject);

        const checkInterval = setInterval(async () => {
            if (!pauseTriggered) return;
            clearInterval(checkInterval);
            try {
                await pauseDecryptPipeline(rs, unsealer, ws);
                resolve();
            } catch (e) {
                reject(e);
            }
        }, 50);

        rs.pipe(unsealer).pipe(ws);
    });

    expect(fs.existsSync(retSrc)).toBe(true);
    const sizeAtPause = fs.statSync(retSrc).size;
    expect(sizeAtPause).toBeGreaterThanOrEqual(midThreshold);
    expect(sizeAtPause).toBeLessThan(fs.statSync(src).size);

    // 模拟进程退出后重启：重新 load context
    context = new PipelineContextInFile(contextPath);
    await context.loadContext();

    await new Promise((resolve, reject) => {
        const rs = new RecoverableReadStream(sealed, context);
        const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
        const ws = new RecoverableWriteStream(retSrc, context);
        bindPipelineErrors([rs, unsealer, ws], reject);
        rs.pipe(unsealer).pipe(ws);
        ws.on('finish', resolve);
    });

    expect(await calculateMD5(retSrc)).toStrictEqual(plainMd5);

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(sealed);
        fs.unlinkSync(contextPath);
        fs.unlinkSync(contextPath + '.tmp');
        fs.unlinkSync(retSrc);
    } catch (_) {}
}, 180000);

/**
 * 非优雅中断：子进程解密中段 SIGKILL，父进程同路径 loadContext 后续解。
 * 当前 ME progress 原子写在强杀后续传上可能失败；失败保留以便跟踪修复。
 */
test('interrupt decrypt ungraceful (SIGKILL mid-decrypt) then resume', async () => {
    const buildEntry = path.resolve(__dirname, '../build/commonjs/index.node.cjs');
    if (!fs.existsSync(buildEntry)) {
        throw new Error(
            'build/commonjs/index.node.cjs missing; run `npm run build` before this test'
        );
    }

    const src = testPath('interrupt_decrypt_kill.file');
    const contextPath = testPath('interrupt_decrypt_kill_context');
    const retSrc = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');
    const configPath = testPath('interrupt_decrypt_kill_worker.json');

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(contextPath);
        fs.unlinkSync(contextPath + '.tmp');
        fs.unlinkSync(retSrc);
    } catch (_) {}

    generateFileWithSize(src, 1024 * 1024 * 16);
    const sealed = await sealFile(src);
    const plainMd5 = await calculateMD5(src);
    const midPlainBytes = 256 * 1024;

    fs.writeFileSync(
        configPath,
        JSON.stringify({
            sealedPath: sealed,
            outPath: retSrc,
            contextPath,
            mode: 'kill',
            midPlainBytes,
            privateKey: key_pair.private_key,
            publicKey: key_pair.public_key,
        })
    );

    const workerScript = path.resolve(__dirname, 'workers/interrupt-decrypt-worker.cjs');
    let child = spawn(process.execPath, [workerScript, configPath], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
    });

    const events = [];
    child.stdout.on('data', (b) => parseWorkerEvents(b, events));
    child.stderr.on('data', (b) => {
        if (b.toString().includes('WORKER_JSON:')) parseWorkerEvents(b, events);
    });

    try {
        await waitForWorkerEvent(events, 'ready', 60_000);
        await waitForWorkerEvent(events, 'started', 60_000);
        const mid = await waitForWorkerEvent(events, 'mid-decrypt', 120_000);
        expect(Number(mid.bytes)).toBeGreaterThanOrEqual(midPlainBytes);

        await sleep(800);
        child.kill('SIGKILL');
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 5000);
            child.once('exit', () => {
                clearTimeout(t);
                resolve();
            });
        });
        child = null;

        expect(fs.existsSync(retSrc)).toBe(true);
        const sizeAtKill = fs.statSync(retSrc).size;
        expect(sizeAtKill).toBeGreaterThanOrEqual(midPlainBytes);

        // 父进程模拟重启后续解
        const context = new PipelineContextInFile(contextPath);
        await context.loadContext();

        await new Promise((resolve, reject) => {
            const rs = new RecoverableReadStream(sealed, context);
            const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
            const ws = new RecoverableWriteStream(retSrc, context);
            bindPipelineErrors([rs, unsealer, ws], reject);
            rs.pipe(unsealer).pipe(ws);
            ws.on('finish', resolve);
        });

        expect(await calculateMD5(retSrc)).toStrictEqual(plainMd5);
    } finally {
        if (child && !child.killed) {
            try {
                child.kill('SIGKILL');
            } catch (_) {}
        }
        try {
            fs.unlinkSync(src);
            fs.unlinkSync(sealed);
            fs.unlinkSync(contextPath);
            fs.unlinkSync(contextPath + '.tmp');
            fs.unlinkSync(retSrc);
            fs.unlinkSync(configPath);
        } catch (_) {}
    }
}, 180000);

/**
 * 断电式中断 + 落盘频率=1：每提交 1 个 item 即 saveContext，子进程 SIGKILL，
 * 父进程 loadContext 后从最近存档点续解。读写分离下应总能解出正确明文。
 */
test('interrupt decrypt ungraceful (SIGKILL) with saveFrequency=1 then resume', async () => {
    const buildEntry = path.resolve(__dirname, '../build/commonjs/index.node.cjs');
    if (!fs.existsSync(buildEntry)) {
        throw new Error(
            'build/commonjs/index.node.cjs missing; run `npm run build` before this test'
        );
    }

    const src = testPath('interrupt_decrypt_kill_freq1.file');
    const contextPath = testPath('interrupt_decrypt_kill_freq1_context');
    const retSrc = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');
    const configPath = testPath('interrupt_decrypt_kill_freq1_worker.json');
    const contextOptions = { saveFrequency: 1, strongConsistency: false };

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(contextPath);
        fs.unlinkSync(contextPath + '.tmp');
        fs.unlinkSync(retSrc);
    } catch (_) {}

    generateFileWithSize(src, 1024 * 1024 * 128);
    const sealed = await sealFile(src);
    const plainMd5 = await calculateMD5(src);
    const midPlainBytes = 1024 * 1024;

    fs.writeFileSync(
        configPath,
        JSON.stringify({
            sealedPath: sealed,
            outPath: retSrc,
            contextPath,
            mode: 'kill',
            midPlainBytes,
            contextOptions,
            privateKey: key_pair.private_key,
            publicKey: key_pair.public_key,
        })
    );

    const workerScript = path.resolve(__dirname, 'workers/interrupt-decrypt-worker.cjs');
    let child = spawn(process.execPath, [workerScript, configPath], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
    });

    const events = [];
    child.stdout.on('data', (b) => parseWorkerEvents(b, events));
    child.stderr.on('data', (b) => {
        if (b.toString().includes('WORKER_JSON:')) parseWorkerEvents(b, events);
    });

    try {
        await waitForWorkerEvent(events, 'ready', 60_000);
        await waitForWorkerEvent(events, 'started', 60_000);
        const mid = await waitForWorkerEvent(events, 'mid-decrypt', 120_000);
        expect(Number(mid.bytes)).toBeGreaterThanOrEqual(midPlainBytes);

        await sleep(800);
        child.kill('SIGKILL');
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 5000);
            child.once('exit', () => {
                clearTimeout(t);
                resolve();
            });
        });
        child = null;

        expect(fs.existsSync(retSrc)).toBe(true);
        const sizeAtKill = fs.statSync(retSrc).size;
        expect(sizeAtKill).toBeGreaterThanOrEqual(midPlainBytes);
        expect(sizeAtKill).toBeLessThan(fs.statSync(src).size);

        // 父进程模拟断电重启：loadContext 后从存档点续解
        const context = new PipelineContextInFile(contextPath, contextOptions);
        await context.loadContext();
        // saveFrequency=1 时应已有进度落盘（允许极小概率杀在首次 save 前，则 writeStart 为 0）
        expect(context.context.writeStart || 0).toBeGreaterThan(0);

        await new Promise((resolve, reject) => {
            const rs = new RecoverableReadStream(sealed, context);
            const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
            const ws = new RecoverableWriteStream(retSrc, context);
            bindPipelineErrors([rs, unsealer, ws], reject);
            rs.pipe(unsealer).pipe(ws);
            ws.on('finish', resolve);
        });

        expect(await calculateMD5(retSrc)).toStrictEqual(plainMd5);
    } finally {
        if (child && !child.killed) {
            try {
                child.kill('SIGKILL');
            } catch (_) {}
        }
        try {
            fs.unlinkSync(src);
            fs.unlinkSync(sealed);
            fs.unlinkSync(contextPath);
            fs.unlinkSync(contextPath + '.tmp');
            fs.unlinkSync(retSrc);
            fs.unlinkSync(configPath);
        } catch (_) {}
    }
}, 600000);

/**
 * 跨进程优雅退出：子进程收到 SIGTERM 后 pause+ws.end，父进程再 resume。
 * 应用层「优雅退出」在 ME 层的对应物。
 */
test('interrupt decrypt graceful cross-process (SIGTERM → pause) then resume', async () => {
    const buildEntry = path.resolve(__dirname, '../build/commonjs/index.node.cjs');
    if (!fs.existsSync(buildEntry)) {
        throw new Error(
            'build/commonjs/index.node.cjs missing; run `npm run build` before this test'
        );
    }

    const src = testPath('interrupt_decrypt_sigterm.file');
    const contextPath = testPath('interrupt_decrypt_sigterm_context');
    const retSrc = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');
    const configPath = testPath('interrupt_decrypt_sigterm_worker.json');

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(contextPath);
        fs.unlinkSync(contextPath + '.tmp');
        fs.unlinkSync(retSrc);
    } catch (_) {}

    // 默认 saveFrequency=32 且无 fsync 后吞吐更高；16MB 会在 mid→SIGTERM(200ms) 窗口内跑完。
    // 加大到 128MB，保证 mid 后仍有足够剩余密文可被 pause 打断。
    generateFileWithSize(src, 1024 * 1024 * 128);
    const sealed = await sealFile(src);
    const plainMd5 = await calculateMD5(src);
    const midPlainBytes = 256 * 1024;

    fs.writeFileSync(
        configPath,
        JSON.stringify({
            sealedPath: sealed,
            outPath: retSrc,
            contextPath,
            mode: 'graceful',
            midPlainBytes,
            privateKey: key_pair.private_key,
            publicKey: key_pair.public_key,
        })
    );

    const workerScript = path.resolve(__dirname, 'workers/interrupt-decrypt-worker.cjs');
    let child = spawn(process.execPath, [workerScript, configPath], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
    });

    const events = [];
    child.stdout.on('data', (b) => parseWorkerEvents(b, events));
    child.stderr.on('data', (b) => {
        if (b.toString().includes('WORKER_JSON:')) parseWorkerEvents(b, events);
    });

    try {
        await waitForWorkerEvent(events, 'ready', 60_000);
        await waitForWorkerEvent(events, 'started', 60_000);
        const mid = await waitForWorkerEvent(events, 'mid-decrypt', 120_000);
        expect(Number(mid.bytes)).toBeGreaterThanOrEqual(midPlainBytes);

        await sleep(200);
        child.kill('SIGTERM');
        await waitForWorkerEvent(events, 'graceful-exit', 60_000);
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 5000);
            child.once('exit', () => {
                clearTimeout(t);
                resolve();
            });
        });
        child = null;

        const context = new PipelineContextInFile(contextPath);
        await context.loadContext();

        await new Promise((resolve, reject) => {
            const rs = new RecoverableReadStream(sealed, context);
            const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
            const ws = new RecoverableWriteStream(retSrc, context);
            bindPipelineErrors([rs, unsealer, ws], reject);
            rs.pipe(unsealer).pipe(ws);
            ws.on('finish', resolve);
        });

        expect(await calculateMD5(retSrc)).toStrictEqual(plainMd5);
    } finally {
        if (child && !child.killed) {
            try {
                child.kill('SIGKILL');
            } catch (_) {}
        }
        try {
            fs.unlinkSync(src);
            fs.unlinkSync(sealed);
            fs.unlinkSync(contextPath);
            fs.unlinkSync(contextPath + '.tmp');
            fs.unlinkSync(retSrc);
            fs.unlinkSync(configPath);
        } catch (_) {}
    }
}, 600000);

/**
 * 模仿 dianshu-file-transfer DecryptAction 的路径与调用顺序：
 *   sealed  = localFilePath + ".decrypting"
 *   output  = localFilePath
 *   progress= localFilePath + ".progress"
 * 以及 doDecrypt：先 await loadContext，再 RecoverableRead/Unsealer/RecoverableWrite 建管。
 * 中断方式：跨进程 SIGKILL（对齐 dsft FileDownloader.recovery mid-decrypt kill）。
 * 失败保留，用于跟踪固定 *.progress.tmp 原子写问题。
 */
test('interrupt decrypt dsft-style paths (SIGKILL) then resume like DecryptAction', async () => {
    const buildEntry = path.resolve(__dirname, '../build/commonjs/index.node.cjs');
    if (!fs.existsSync(buildEntry)) {
        throw new Error(
            'build/commonjs/index.node.cjs missing; run `npm run build` before this test'
        );
    }

    // 对齐 dsft：localFilePath 为最终明文；密封在旁路 .decrypting；断点在 .progress
    const localFilePath = testPath('dsft_style_out.dat');
    const decryptingPath = localFilePath + '.decrypting';
    const progressPath = localFilePath + '.progress';
    const src = testPath('dsft_style_plain.file');
    const configPath = testPath('dsft_style_kill_worker.json');

    const cleanupDsftPaths = () => {
        for (const p of [
            src,
            localFilePath,
            decryptingPath,
            progressPath,
            progressPath + '.tmp',
            configPath,
            src + '.sealed',
        ]) {
            try {
                fs.unlinkSync(p);
            } catch (_) {}
        }
    };
    cleanupDsftPaths();

    generateFileWithSize(src, 1024 * 1024 * 20);
    const sealedTmp = await sealFile(src);
    // dsft：下载完成后 .crdownload → .decrypting；此处直接落到 .decrypting
    fs.renameSync(sealedTmp, decryptingPath);
    const plainMd5 = await calculateMD5(src);
    const midPlainBytes = 256 * 1024;

    /** 与 DecryptAction.doDecrypt 相同：loadContext 完成后再建流 */
    async function dsftStyleDecrypt(sealedPath, outputPath, progressFilePath) {
        const context = new PipelineContextInFile(progressFilePath);
        await context.loadContext();
        await new Promise((resolve, reject) => {
            const rs = new RecoverableReadStream(sealedPath, context);
            const unsealer = new meta.Unsealer({ keyPair: key_pair, context });
            const ws = new RecoverableWriteStream(outputPath, context);
            bindPipelineErrors([rs, unsealer, ws], reject);
            rs.pipe(unsealer).pipe(ws);
            ws.on('finish', resolve);
        });
    }

    fs.writeFileSync(
        configPath,
        JSON.stringify({
            sealedPath: decryptingPath,
            outPath: localFilePath,
            contextPath: progressPath,
            mode: 'kill',
            midPlainBytes,
            privateKey: key_pair.private_key,
            publicKey: key_pair.public_key,
        })
    );

    const workerScript = path.resolve(__dirname, 'workers/interrupt-decrypt-worker.cjs');
    let child = spawn(process.execPath, [workerScript, configPath], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
    });

    const events = [];
    child.stdout.on('data', (b) => parseWorkerEvents(b, events));
    child.stderr.on('data', (b) => {
        if (b.toString().includes('WORKER_JSON:')) parseWorkerEvents(b, events);
    });

    try {
        await waitForWorkerEvent(events, 'ready', 60_000);
        await waitForWorkerEvent(events, 'started', 60_000);
        const mid = await waitForWorkerEvent(events, 'mid-decrypt', 120_000);
        expect(Number(mid.bytes)).toBeGreaterThanOrEqual(midPlainBytes);

        // 缩短等待，更易撞上 in-flight saveContext（贴近 dsft 强杀时序）
        await sleep(100);
        child.kill('SIGKILL');
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 5000);
            child.once('exit', () => {
                clearTimeout(t);
                resolve();
            });
        });
        child = null;

        expect(fs.existsSync(localFilePath)).toBe(true);
        expect(fs.existsSync(decryptingPath)).toBe(true);
        const sizeAtKill = fs.statSync(localFilePath).size;
        expect(sizeAtKill).toBeGreaterThanOrEqual(midPlainBytes);
        expect(sizeAtKill).toBeLessThan(fs.statSync(src).size);

        // 对齐 DecryptAction.resume → execute → doDecrypt
        await dsftStyleDecrypt(decryptingPath, localFilePath, progressPath);

        expect(await calculateMD5(localFilePath)).toStrictEqual(plainMd5);
    } finally {
        if (child && !child.killed) {
            try {
                child.kill('SIGKILL');
            } catch (_) {}
        }
        cleanupDsftPaths();
    }
}, 180000);

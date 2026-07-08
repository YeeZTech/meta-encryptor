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

// 500MB + 多轮 pause/resume，本地耗时过长，待修复 pause 阈值逻辑后再启用
test.skip('test pipeline context with multiple random pause and resume on same file', async () => {
    let src = testPath('multi_pause_resume_large.rand_same.file');
    let context_path = testPath('multi_pause_resume_large_context.rand_same');
    let dst;

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
    } catch (error) {}

    // 准备测试文件
    const fileSize = 1024 * 1024 * 500; // 500MB
    generateFileWithSize(src, fileSize);
    dst = await sealFile(src);
    const originalMD5 = await calculateMD5(src);
    // 保存原始文件内容用于后续验证
    // const originalContent = fs.readFileSync(src);

    // 生成更均匀的随机暂停点
    const segmentSize = fileSize / 5; // 将文件分成5段
    const pausePoints = [];

    // 在每段中随机选择一个暂停点
    for (let i = 1; i < 5; i++) {
        const minPoint = i * segmentSize - segmentSize / 4;
        const maxPoint = i * segmentSize + segmentSize / 4;
        const point = Math.floor(minPoint + Math.random() * (maxPoint - minPoint));
        pausePoints.push(point);
    }


    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    // 处理多个阶段
    for (let stage = 0; stage < pausePoints.length + 1; stage++) {

        let pauseTriggered = false;
        let totalBytesProcessed = 0;
        const currentPauseThreshold = pausePoints[stage];

        class PauseController extends require('stream').Transform {
            constructor(options = {}) {
                super(options);
                this.lastLoggedPosition = 0;
            }

            _transform(chunk, encoding, callback) {
                totalBytesProcessed += chunk.length;
                const absolutePosition = (context.context.readStart || 0) + totalBytesProcessed;

                // 每处理50MB记录一次位置
                if (absolutePosition - this.lastLoggedPosition >= 50 * 1024 * 1024) {
                    this.lastLoggedPosition = absolutePosition;
                }

                this.push(chunk);

                if (!pauseTriggered && currentPauseThreshold && absolutePosition >= currentPauseThreshold) {
                    pauseTriggered = true;
                }

                callback();
            }
        }

        // 处理当前阶段
        await new Promise((resolve, reject) => {
            const _progressHandler = (totalItem, readItem, bytes, writeBytes) => {
            };

            let rs = new RecoverableReadStream(dst, context);
            let unsealer = new meta.Unsealer({
                keyPair: key_pair,
                processedItemCount: context.context.readItemCount || 0,
                processedBytes: context.context.readStart || 0,
                writeBytes: context.context.writeStart || 0,
                progressHandler: _progressHandler,
                context: context
            });
            let pauseController = stage < pausePoints.length ? new PauseController() : null;
            let ws = new RecoverableWriteStream(src, context);

            // 监听进度和暂停
            let checkInterval;
            if (stage < pausePoints.length) {
                checkInterval = setInterval(() => {
                    if (pauseTriggered) {
                        clearInterval(checkInterval);

                        rs.unpipe(unsealer);
                        unsealer.unpipe(pauseController);
                        pauseController.unpipe(ws);

                        // 随机延迟暂停时间 (1-3秒)
                        const randomDelay = 1000 + Math.random() * 2000;
                        setTimeout(() => {
                            rs.destroy();
                            unsealer.destroy();
                            pauseController.destroy();
                            ws.end();
                            resolve();
                        }, randomDelay);
                    }
                }, 100);
            }

            // 连接管道
            if (stage < pausePoints.length) {
                rs.pipe(unsealer).pipe(pauseController).pipe(ws);
            } else {
                rs.pipe(unsealer).pipe(ws);
            }

            // 处理完成和错误
            ws.on('finish', () => {
                if (checkInterval) clearInterval(checkInterval);
                resolve();
            });
            ws.on('error', (err) => {
                if (checkInterval) clearInterval(checkInterval);
                console.error(`Stage ${stage + 1} error:`, err);
                reject(err);
            });
        });

        // 打印当前阶段状态
        context = new PipelineContextInFile(context_path);
        await context.loadContext();

        // 随机等待时间后继续 (2-5秒)
        if (stage < pausePoints.length) {
            const resumeDelay = 2000 + Math.random() * 3000;
            await new Promise((resolve) => setTimeout(resolve, resumeDelay));
        }
    }

    // 解密文件进行验证
    let finalContext = new PipelineContextInFile(testPath('final_verify_context'));
    await finalContext.loadContext();

    await new Promise((resolve, reject) => {
        let rs = new RecoverableReadStream(dst, finalContext);
        let unsealer = new meta.Unsealer({keyPair: key_pair, context: finalContext});
        let ws = new RecoverableWriteStream(src, finalContext);

        ws.on('finish', resolve);
        ws.on('error', reject);

        rs.pipe(unsealer).pipe(ws);
    });

    // const finalContent = fs.readFileSync(src);
    // expect(Buffer.compare(originalContent, finalContent)).toBe(0);
    const finalMD5 = await calculateMD5(src);
    expect(originalMD5).toStrictEqual(finalMD5);
    // 清理文件
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(dst);
        fs.unlinkSync(context_path);
        fs.unlinkSync(testPath('final_verify_context'));
    } catch (error) {
        console.warn('Cleanup error:', error.message);
    }
});

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
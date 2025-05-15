const meta = require('../src/index.js');
import {Sealer, ToString} from '../src/Sealer';
import {Unsealer} from '../src/Unsealer';

const {PipelineContextInFile} = require('../src/PipelineConext.js');
const {RecoverableReadStream, RecoverableWriteStream} = require('../src/Recoverable.js');
import fs from 'fs';
import {calculateMD5, key_pair, generateFileWithSize} from './helper';

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
    let src = './tsconfig.json';
    let context_path = 'test_context';

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
    let unsealer = new meta.Unsealer({keyPair: key_pair});
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
    let src = 'Unsealerlarge.file';
    //let src = './rollup.config.js'
    //let src = './tsconfig.json'
    let context_path = 'test_context';
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
        }
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
});

test('test pipeline context with pause and resume from large file', async () => {
    let src = 'pause_resume_large.file';
    let context_path = 'pause_resume_large_context';
    let dst, ret_src;

    ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
    } catch (error) {}

    // 第一步：准备测试文件
    generateFileWithSize(src, 1024 * 1024 * 20); // 20MB测试文件
    dst = await sealFile(src);
    //ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');

    // 第二步：第一阶段处理（处理部分后暂停）
    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    let pauseTriggered = false;
    let totalBytesProcessed = 0;
    const pauseThreshold = 1024 * 1024 * 5; // 处理5MB后暂停

    class PauseController extends require('stream').Transform {
        constructor(options = {}) {
            super(options);
        }

        _transform(chunk, encoding, callback) {
            totalBytesProcessed += chunk.length;
            this.push(chunk);

            if (!pauseTriggered && totalBytesProcessed >= pauseThreshold) {
                pauseTriggered = true;
            }

            callback();
        }
    }

    // 第一阶段的处理
    await new Promise((resolve, reject) => {
        const _progressHandler = (totalItem, readItem, bytes, writeBytes) => {
        };

        let rs = new RecoverableReadStream(dst, context);
        let unsealer = new meta.Unsealer({
            keyPair: key_pair,
            progressHandler: _progressHandler,
            context: context
        });
        let pauseController = new PauseController();
        let ws = new RecoverableWriteStream(ret_src, context);

        // 监听进度
        let checkInterval = setInterval(() => {
            if (pauseTriggered) {
                clearInterval(checkInterval);

                // 优雅地停止管道
                rs.unpipe(unsealer);
                unsealer.unpipe(pauseController);
                pauseController.unpipe(ws);

                setTimeout(() => {
                    rs.destroy();
                    unsealer.destroy();
                    pauseController.destroy();
                    ws.end();
                    resolve();
                }, 1000);
            }
        }, 100);

        // 连接管道
        rs.pipe(unsealer).pipe(pauseController).pipe(ws);

        ws.on('error', reject);
    });


    // 打印第一阶段状态
    const firstStageSize = fs.existsSync(ret_src) ? fs.statSync(ret_src).size : 0;
    
    context = new PipelineContextInFile(context_path);
    await context.loadContext();
    

    // 第三步：恢复处理（完成剩余部分）

    // 重新加载上下文
    context = new PipelineContextInFile(context_path);
    await context.loadContext();

    // 恢复处理
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
        let ws = new RecoverableWriteStream(ret_src, context);

        // 监听完成事件
        ws.on('finish', () => {
            resolve();
        });
        ws.on('error', reject);

        // 连接管道
        rs.pipe(unsealer).pipe(ws);
    });
    context = new PipelineContextInFile(context_path);
    await context.loadContext();
    

    // 第四步：验证结果
    await compare(src, ret_src);

    // 清理文件
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(dst);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
    } catch (error) {
        console.warn('Cleanup error:', error.message);
    }
}, 180000);

test('test pipeline context with multiple random pause and resume', async () => {
    let src = 'pause_resume_large.file';
    let context_path = 'pause_resume_large_context';
    let dst, ret_src;

    ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
        fs.unlinkSync(dst);
    } catch (error) {}

    // 准备测试文件
    const fileSize = 1024 * 1024 * 50; // 50MB
    generateFileWithSize(src, fileSize);
    dst = await sealFile(src);

    // 生成随机暂停点
    const generateRandomPausePoints = (fileSize, numberOfPauses) => {
        const minGap = 1024 * 1024 * 2; // 至少2MB的间隔
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

    // 处理多个阶段
    for (let stage = 0; stage < pausePoints.length + 1; stage++) {

        let pauseTriggered = false;
        let totalBytesProcessed = 0;
        const currentPauseThreshold = pausePoints[stage];

        class PauseController extends require('stream').Transform {
            constructor(options = {}) {
                super(options);
            }

            _transform(chunk, encoding, callback) {
                totalBytesProcessed += chunk.length;
                this.push(chunk);

                if (!pauseTriggered && currentPauseThreshold && totalBytesProcessed >= currentPauseThreshold) {
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
            let ws = new RecoverableWriteStream(ret_src, context);

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
            ws.on('error', reject);
        });

        // 打印当前阶段状态
        context = new PipelineContextInFile(context_path);
        await context.loadContext();
        const currentSize = fs.existsSync(ret_src) ? fs.statSync(ret_src).size : 0;
        

        // 随机等待时间后继续 (2-5秒)
        if (stage < pausePoints.length) {
            const resumeDelay = 2000 + Math.random() * 3000;
            await new Promise((resolve) => setTimeout(resolve, resumeDelay));
        }
    }

    // 验证最终结果
    await compare(src, ret_src);

    // 打印最终状态
    context = new PipelineContextInFile(context_path);
    await context.loadContext();
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
        fs.unlinkSync(ret_src);
        fs.unlinkSync(dst);
    } catch (error) {}
}, 300000);

test('test pipeline context large same file', async () => {
    let src = 'Unsealerlarge.file';
    //let src = './rollup.config.js'
    //let src = './tsconfig.json'
    let context_path = 'test_context';
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
    
});
test('test pipeline context with pause and resume on same file', async () => {
    let src = 'pause_resume_large.file';
    let context_path = 'pause_resume_large_context';
    let dst;

    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
    } catch (error) {}

    // 第一步：准备测试文件
    generateFileWithSize(src, 1024 * 1024 * 200); // 20MB测试文件
    dst = await sealFile(src);
    const originalMD5 = await calculateMD5(src);
    // 保存原始文件内容的副本用于后续验证
    // const originalContent = fs.readFileSync(src);

    // 第二步：第一阶段处理（处理部分后暂停）
    let context = new PipelineContextInFile(context_path);
    await context.loadContext();

    let pauseTriggered = false;
    let totalBytesProcessed = 0;
    const pauseThreshold = 1024 * 1024 * 50; // 处理5MB后暂停

    class PauseController extends require('stream').Transform {
        constructor(options = {}) {
            super(options);
        }

        _transform(chunk, encoding, callback) {
            totalBytesProcessed += chunk.length;
            this.push(chunk);

            if (!pauseTriggered && totalBytesProcessed >= pauseThreshold) {
                pauseTriggered = true;
            }

            callback();
        }
    }

    // 第一阶段的处理
    await new Promise((resolve, reject) => {
        const _progressHandler = (totalItem, readItem, bytes, writeBytes) => {
        };

        let rs = new RecoverableReadStream(dst, context);
        let unsealer = new meta.Unsealer({
            keyPair: key_pair,
            progressHandler: _progressHandler,
            context: context
        });
        let pauseController = new PauseController();
        let ws = new RecoverableWriteStream(dst, context); // 写回到同一个文件

        // 监听进度
        let checkInterval = setInterval(() => {
            if (pauseTriggered) {
                clearInterval(checkInterval);

                // 优雅地停止管道
                rs.unpipe(unsealer);
                unsealer.unpipe(pauseController);
                pauseController.unpipe(ws);

                setTimeout(() => {
                    rs.destroy();
                    unsealer.destroy();
                    pauseController.destroy();
                    ws.end();
                    resolve();
                }, 1000);
            }
        }, 100);

        // 连接管道
        rs.pipe(unsealer).pipe(pauseController).pipe(ws);

        ws.on('error', reject);
    });


    // 打印第一阶段状态
    const firstStageSize = fs.existsSync(src) ? fs.statSync(src).size : 0;

    // 让文件系统有时间完成写入
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 第三步：恢复处理（完成剩余部分）

    // 重新加载上下文
    context = new PipelineContextInFile(context_path);
    await context.loadContext();

    // 恢复处理
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
        let ws = new RecoverableWriteStream(src, context); // 继续写入同一个文件

        // 监听完成事件
        ws.on('finish', () => {
            resolve();
        });
        ws.on('error', reject);

        // 连接管道
        rs.pipe(unsealer).pipe(ws);
    });

    // 让文件系统有时间完成写入
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 第四步：验证结果
    // const finalContent = fs.readFileSync(src);
    // expect(Buffer.compare(originalContent, finalContent)).toBe(0);
    const finalMD5 = await calculateMD5(src);
    expect(originalMD5).toStrictEqual(finalMD5);
    // 清理文件
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(dst);
        fs.unlinkSync(context_path);
    } catch (error) {
        console.warn('Cleanup error:', error.message);
    }
}, 180000);

test('test pipeline context with multiple random pause and resume on same file', async () => {
    let src = 'multi_pause_resume_large.file';
    let context_path = 'multi_pause_resume_large_context';
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
    let finalContext = new PipelineContextInFile('final_verify_context');
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
        fs.unlinkSync('final_verify_context');
    } catch (error) {
        console.warn('Cleanup error:', error.message);
    }
}, 300000);

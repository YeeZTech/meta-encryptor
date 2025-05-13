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

  try{
    fs.unlinkSync(context_path);
    fs.unlinkSync(ret_src);
 }
  catch(error){}
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

    // 打印初始上下文状态
    console.log('Initial context state:', {
        readStart: context.context.readStart,
        writeStart: context.context.writeStart,
        hasData: context.context.data ? true : false,
        dataLength: context.context.data ? context.context.data.length : 0
    });
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
        console.log('progress', {
            totalItem,
            readItem,
            bytes,
            writeBytes
        });
    };
    // 监听读取流的数据事件
    rs.on('data', (chunk) => {
        bytesRead += chunk.length;

        // 每10MB打印一次状态，避免过多输出
        if (bytesRead - lastReportedRead >= 10 * 1024 * 1024) {
            console.log(`Read: ${bytesRead / (1024 * 1024)}MB | Context:`, {
                readStart: context.context.readStart,
                writeStart: context.context.writeStart,
                dataBufferSize: context.context.data ? context.context.data.length : 0
            });
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
                console.log(`Written: ${bytesWritten / (1024 * 1024)}MB`);
                lastReportedWrite = bytesWritten;
            }
        });
    }

    // 监听监听写入流的进度
    let writeProgress = 0;
    if (ws.on && typeof ws.on === 'function') {
        ws.on('drain', () => {
            const currentWritten = ws.bytesWritten || 0; // 某些流会提供这个属性
            if (currentWritten > writeProgress) {
                console.log(`Write progress: ${currentWritten / (1024 * 1024)}MB`);

                writeProgress = currentWritten;
            }
        });
    }

    // 启动处理
    rs.pipe(unsealer).pipe(ws);

    await new Promise((resolve) => {
        ws.on('finish', () => {
            console.log('Processing complete!');
            console.log(`Total bytes read: ${bytesRead / (1024 * 1024)}MB`);
            console.log(`Final context state:`, {
                readStart: context.context.readStart,
                writeStart: context.context.writeStart,
                dataBufferSize: context.context.data ? context.context.data.length : 0
            });
            resolve();
        });
    });
    console.log('compare:', src, ret_src);
    await compare(src, ret_src);

    // fs.unlinkSync(src);
    // fs.unlinkSync(context_path);
    // fs.unlinkSync(ret_src);
});

test('test pipeline context with pause and resume from large file', async () => {
    let src = 'pause_resume_large.file';
    let context_path = 'pause_resume_large_context';
    let dst, ret_src;

    ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');
    try {
        fs.unlinkSync(src);
        fs.unlinkSync(context_path);
      fs.unlinkSync(ret_src)
    } catch (error) {}

    // 第一步：准备测试文件
    console.log('Generating test file...');
    generateFileWithSize(src, 1024 * 1024 * 20); // 20MB测试文件
    dst = await sealFile(src);
    //ret_src = path.join(path.dirname(src), path.basename(src) + '.sealed.ret');

    // 第二步：第一阶段处理（处理部分后暂停）
    console.log('Stage 1: Processing initial part...');
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
                console.log(`Processed ${totalBytesProcessed / (1024 * 1024)}MB, triggering pause`);
            }

            callback();
        }
    }

    // 第一阶段的处理
    await new Promise((resolve, reject) => {
        const _progressHandler = (totalItem, readItem, bytes, writeBytes) => {
            console.log('Stage 1 progress:', {totalItem, readItem, bytes, writeBytes});
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
                console.log('Pausing pipeline...');
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

    console.log('Stage 1 completed, context saved');

    // 打印第一阶段状态
    const firstStageSize = fs.existsSync(ret_src) ? fs.statSync(ret_src).size : 0;
    console.log('First stage processed:', {
        processedMB: firstStageSize / (1024 * 1024),
        contextState: {
            readStart: context.context.readStart,
            writeStart: context.context.writeStart,
            hasData: context.context.data ? true : false,
            dataLength: context.context.data ? context.context.data.length : 0
        }
    });
    context = new PipelineContextInFile(context_path);
    await context.loadContext();
    console.log('context saved:', {
        processedMB: firstStageSize / (1024 * 1024),
        contextState: {
            readStart: context.context.readStart,
            writeStart: context.context.writeStart,
            hasData: context.context.data ? true : false,
            dataLength: context.context.data ? context.context.data.length : 0
        }
    });

    // 第三步：恢复处理（完成剩余部分）
    console.log('Stage 2: Resuming processing...');

    // 重新加载上下文
    context = new PipelineContextInFile(context_path);
    await context.loadContext();

    // 恢复处理
    await new Promise((resolve, reject) => {
        const _progressHandler = (totalItem, readItem, bytes, writeBytes) => {
            console.log('Stage 2 progress:', {totalItem, readItem, bytes, writeBytes});
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
            console.log('Processing complete');
            resolve();
        });
        ws.on('error', reject);

        // 连接管道
        rs.pipe(unsealer).pipe(ws);
    });
    context = new PipelineContextInFile(context_path);
    await context.loadContext();
    console.log('final context saved:', {
        //processedMB: firstStageSize / (1024 * 1024),
        contextState: {
            readStart: context.context.readStart,
            writeStart: context.context.writeStart,
            hasData: context.context.data ? true : false,
            dataLength: context.context.data ? context.context.data.length : 0
        }
    });

    // 第四步：验证结果
    console.log('Verifying results...');
    await compare(src, ret_src);
    console.log('Verification successful');

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
    console.log('aaaa');
    let dst = await sealFile(src);
    console.log('bb');
    let ret_src = src;

    console.log('ccc');
    let m1 = await calculateMD5(src);

    let context = new PipelineContextInFile(context_path);
    context.loadContext();
    console.log('ddd');
    let rs = new RecoverableReadStream(dst, context);
    let ws = new RecoverableWriteStream(ret_src, context);
    let unsealer = new meta.Unsealer({keyPair: key_pair, context:context});
    rs.pipe(unsealer).pipe(ws);

    await new Promise((resolve) => {
        ws.on('finish', () => {
            resolve();
        });
    });

    let m2 = await calculateMD5(ret_src);
    expect(m1.length > 0).toBe(true);
    expect(m1).toStrictEqual(m2);

    fs.unlinkSync(src);
    fs.unlinkSync(context_path);
    //fs.unlinkSync(ret_src)
});

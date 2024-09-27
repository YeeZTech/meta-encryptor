import { ProgressInfoStream } from "../src/ProgressInfoStream"
import fs from 'fs'
import log from 'loglevel'
import waterfallUntil from 'run-waterfall-until'
const logger = require("loglevel").getLogger("meta-encryptor/ProgressInfoStream");
const { Readable } = require('stream');

log.setLevel('DEBUG')
logger.setLevel('DEBUG')

test('ProgressInfoStream', async () => {
  const src = "progressInfoStream.file";
  const progressFilePath = "progressInfoText.file";
  try{
    fs.unlinkSync(src)
  }catch(error){}
  const writeStream = new ProgressInfoStream({
    filePath: src,
    progressFilePath
  })
  writeStream.once('processInfoAvailable',  (res) => {
    log.debug('processInfoAvailable res', res)
  })
  // 创建一个可读流 (模拟)
  const readableStream = new Readable({
    objectMode: true,
    read(size) {
      // 模拟数据流，向可读流中推送数据
      this.push({
        chunk: Buffer.from('hello'),
        processedBytes: Buffer.from('hello').length,
        readItemCount: 1,
        totalItem: 1
      });
      this.push(null); // 使用 null 表示数据流结束
    }
  });

  await writeStream.initialize();

  // 将可读流通过 pipe 方法连接到自定义写入流
  readableStream.pipe(writeStream);

  writeStream.on('progress', (...args) => {
    log.info('progress', args)
  })

  writeStream.on('error', (e) => {
    log.error('writeStream error', e)
  })

  await new Promise((resolve) => {
    writeStream.on('close', resolve)
  })
  fs.unlinkSync(src)
  // fs.unlinkSync(progressFilePath)
})

test.skip('test waterfallUntil', async () => {
  await new Promise((resolve, reject) => {
    waterfallUntil([
      function (arg1, arg2, callback) {
        log.debug('one')
        // arg1 now equals 'foo', and arg2 - 'bar'
        // false means continue
        callback(null, false, 'one', 'two');
      },
      function (arg1, arg2, callback) {
        // arg1 now equals 'one', and arg2 - 'two'
        // true means break out of the loop
        log.debug('two')
        callback(null, false, 'three');
      },
      function (arg1, callback) {
        log.debug('three')
        // this function is not called since previous one has called callback with 'true' 
        callback(null, 'done', 'wohoo');
      }
    ], 'foo', 'bar', function (err, result1) {
       // result1 now equals 'three'
       if (err) {
        log.error(err)
        reject(err)
       }
       log.info(result1)
       resolve()
    })
  })
})

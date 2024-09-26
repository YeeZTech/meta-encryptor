import { ProgressInfoStream } from "../src/ProgressInfoStream"
import fs from 'fs'
import log from 'loglevel'
const logger = require("loglevel").getLogger("meta-encryptor/ProgressInfoStream");
const { Readable } = require('stream');

log.setLevel('DEBUG')
logger.setLevel('DEBUG')

test('ProgressInfoStream', async () => {
  const src = "progressInfoStream.file";
  const processFilePath = "progressInfoText.file";
  try{
    fs.unlinkSync(src)
  }catch(error){}
  const writeStream = new ProgressInfoStream({
    filePath: src,
    processFilePath
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

  await new Promise((resolve) => {
    writeStream.on('close', resolve)
  })
  fs.unlinkSync(src)
  fs.unlinkSync(processFilePath)
})

import {Sealer, ToString} from "../src/Sealer"
import {UnsealerWithProgressInfo} from "../src/UnsealerWithProgressInfo"
import {SealedFileStream} from "../src/SealedFileStream"
import { downloadSealFileForStream } from "../src/http/downloadFileForStream"
import { ProgressInfoStream } from "../src/ProgressInfoStream"

const path = require('path');
import fs from "fs";
const crypto = require('crypto');
const csv = require('csv-parser')
const stream = require("stream");

const log = require('loglevel');
var unsealer_log = require("loglevel").getLogger("meta-encryptor/Unsealer");
var unsealer_stream_log = require("loglevel").getLogger("meta-encryptor/SealedFileStream");
import{calculateMD5, key_pair, generateFileWithSize, tusConfig} from "./helper"

log.setLevel('INFO')
// unsealer_log.setLevel('DEBUG')
//unsealer_stream_log.setLevel("trace")

// 本地下载文件的服务
const tusDownloadUrl = tusConfig.downloadUrl

const tusFileDir = tusConfig.tusFileDir

async function sealAndUnsealFile(src, useRemoteSealedFileStream = false){
  let dstFileName = path.basename(src) + ".sealed"
  let dst = useRemoteSealedFileStream ? path.join(tusFileDir, dstFileName) : path.join(path.dirname(src), dstFileName);
  let ret_src = path.join(path.dirname(src), path.basename(src) + ".unsealed.ret");
  let processFilePath = path.basename(src) + ".pro"

  let rs = fs.createReadStream(src)
  let ws = fs.createWriteStream(dst)
  let tag = 'seal ' + src + ' cost time'
  console.time(tag)
  rs.pipe(new Sealer({keyPair: key_pair})).pipe(ws)
  await new Promise((resolve)=>{
    ws.on('finish', ()=>{
      resolve();
    });
  });
  console.timeEnd(tag)

  let keep = true;
  let status = {processedBytes:0, processedItems:0, writeBytes: 0}
  let last_status = JSON.parse(JSON.stringify(status));
  const progressHandler=function(totalItem, readItem, bytes, writeBytes){
    log.info("total item: ", totalItem, "readItem: ", readItem, "bytes: ", bytes, ", write bytes: ", writeBytes)
    last_status = JSON.parse(JSON.stringify(status));
    status.processedBytes = bytes;
    status.processedItems = readItem;
    status.writeBytes = writeBytes;
    if(readItem === totalItem){
      keep = false;
    }
  }

  try{
    fs.unlinkSync(ret_src);
  }catch(err){}

  while(keep){
    // let ret_ws = new UnsealerRelatedWriteStream(ret_src, {flags:'a'});
    let ret_ws = new ProgressInfoStream({
      filePath: ret_src,
      processFilePath
    });
    ret_ws.once('processInfoAvailable',  (res) => {
      log.debug('processInfoAvailable res', res)
      status.processedBytes = res.processedBytes;
      status.processedItems = res.readItemCount;
      status.writeBytes = res.writeSucceedBytes;
    })
    await ret_ws.initialize()
    let unsealer = new UnsealerWithProgressInfo({keyPair:key_pair,
      processedItemCount:status.processedItems,
      processedBytes : status.processedBytes,
      writeBytes : status.writeBytes
    })
    let sealedStream
    if (useRemoteSealedFileStream) {
      const res = await downloadSealFileForStream(tusDownloadUrl, dstFileName, {start: status.processedBytes})
      sealedStream = res.data
    } else {
      sealedStream = new SealedFileStream(dst, {start:status.processedBytes, highWaterMark: 64 * 1024 })
    }

    let count = 0;
    //let rand = Math.floor(Math.random() * 10);
    let rand = 1
    let ctrlStream = new stream.Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        try{
          this.push(chunk);
          count += 1;
          if(count >= rand){
            this.push(null);
            sealedStream.destroy();
            unsealer.destroy();
          }
          callback();
        }catch(err){
          callback(err)
        }
      }
    });

    ctrlStream.on('error', (error)=>{
      log.error("error", error)
      //status = last_status;
    })
    
    let v = sealedStream.pipe(unsealer).pipe(ctrlStream).pipe(ret_ws);
    ret_ws.on('progress', (processedBytes, readItemCount, totalItem, writeSucceedBytes) => {
      log.info('progress', processedBytes, readItemCount, totalItem, writeSucceedBytes)
      status.processedBytes = processedBytes;
      status.processedItems = readItemCount;
      status.writeBytes = writeSucceedBytes;
      if(readItemCount === totalItem){
        keep = false;
      }
    })
    await new Promise((resolve)=>{
      log.debug("wait finish");
      ret_ws.on('finish', ()=>{
      log.debug("got finish");
        sealedStream.destroy();
        unsealer.destroy();
        ctrlStream.destroy();
        resolve();
      });
    });
  }

  let m1 = await calculateMD5(src)
  let m2 = await calculateMD5(ret_src);
  expect(m1.length > 0).toBe(true)
  expect(m1).toStrictEqual(m2);
  fs.unlinkSync(dst);
  fs.unlinkSync(ret_src);
  fs.unlinkSync(processFilePath)
}


test('seal small file', async()=>{

  let src = './webpack.config.js';
  await sealAndUnsealFile(src);
})

test('test medium file', async()=>{
  let src = './README.md';
  await sealAndUnsealFile(src);
})

test('test large file', async()=>{
  let src = "UnsealerWithProgressInfoLarge.file";
  try{
    fs.unlinkSync(src)
  }catch(error){

  }
  //100MB
  generateFileWithSize(src,  1024 * 1024 * 100)
  await sealAndUnsealFile(src);
  fs.unlinkSync(src)
})

test.skip('test large file use RemoteSealedFileStream', async()=>{
  let src = "test.remote.xUnsealerlarge.file";
  try{
    fs.unlinkSync(src)
  }catch(error){

  }
  //100MB
  generateFileWithSize(src,  1024 * 1024 * 100)
  await sealAndUnsealFile(src, true);
  // await sealAndUnsealFile(src);
  fs.unlinkSync(src)
})

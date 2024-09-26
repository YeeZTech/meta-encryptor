import {Sealer, ToString} from "../src/Sealer"
import {Unsealer} from "../src/Unsealer"
import {SealedFileStream} from "../src/SealedFileStream"

const path = require('path');
import fs from "fs";
const crypto = require('crypto');
const csv = require('csv-parser')

const log = require('loglevel');
var unsealer_log = require("loglevel").getLogger("meta-encryptor/Unsealer");
var unsealer_stream_log = require("loglevel").getLogger("meta-encryptor/SealedFileStream");
import{calculateMD5, key_pair, generateFileWithSize} from "./helper"

// 设置日志级别
//log.setLevel('trace');
//unsealer_log.setLevel("trace")
//unsealer_stream_log.setLevel("trace")


async function sealAndUnsealFile(src){
  let dst = path.join(path.dirname(src), path.basename(src) + ".sealed");
  let ret_src = path.join(path.dirname(src), path.basename(src) + ".sealed.ret");

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

  tag = 'stream unseal ' + src + ' cost time'
  console.time(tag)
  let sealedStream = new SealedFileStream(dst);
  let ret_ws = fs.createWriteStream(ret_src);

  let unsealer = new Unsealer({keyPair: key_pair});
  sealedStream.pipe(unsealer).pipe(ret_ws);
  sealedStream.on('error', (error)=>{
    console.log("got error: ", error);
  })
  unsealer.on('error', (error)=>{
    console.log("got error: ", error);
  })
  await new Promise((resolve)=>{
    ret_ws.on('finish', ()=>{
      resolve();
    });
  });
  console.timeEnd(tag)

  let m1 = await calculateMD5(src)
  let m2 = await calculateMD5(ret_src);
  expect(m1.length > 0).toBe(true)
  expect(m1).toStrictEqual(m2);
  fs.unlinkSync(dst);
  fs.unlinkSync(ret_src);
}
test('seal small file', async()=>{

  let src = './tsconfig.json';
  await sealAndUnsealFile(src);
})

test('test medium file', async()=>{
  let src = './yarn.lock';
  await sealAndUnsealFile(src);
})



test('test large file', async()=>{
  let src = "large.file";
  try{
    fs.unlinkSync(src)
  }catch(error){

  }
  //100MB
  generateFileWithSize(src,  1024 * 1024 * 100)
   await sealAndUnsealFile(src);
   fs.unlinkSync(src)
})


async function sealAndUnsealCSVFile(src){
  let dst = path.join(path.dirname(src), path.basename(src) + ".sealed");
  let ret_src = path.join(path.dirname(src), path.basename(src) + ".sealed.ret");

  let rs = fs.createReadStream(src)
  let ws = fs.createWriteStream(dst)
  let tag = 'seal ' + src + ' cost time'
  console.time(tag)
  rs.pipe(csv()).pipe(new ToString()).pipe(new Sealer({keyPair: key_pair})).pipe(ws)
  await new Promise((resolve)=>{
    ws.on('finish', ()=>{
      resolve();
    });
  });
  console.timeEnd(tag)

  let sealedStream = new SealedFileStream(dst);
  let ret_ws = fs.createWriteStream(ret_src);
  sealedStream.pipe(new Unsealer({keyPair: key_pair})).pipe(ret_ws);
  await new Promise((resolve)=>{
    ret_ws.on('finish', ()=>{
      resolve();
    });
  });

  //let unsealer = new FileProvider(key_pair, dst, ret_src);
  //let promise1 = unsealer.unsealFile()
  //await promise1;
  let m1 = await calculateMD5(src)
  let m2 = await calculateMD5(ret_src);
  expect(m1.length > 0).toBe(true)
  //expect(m1).toStrictEqual(m2);
  fs.unlinkSync(dst);
  fs.unlinkSync(ret_src);
}
test('test CSV file', async()=>{
  let src = "./test/test.csv";
  await sealAndUnsealCSVFile(src);
})
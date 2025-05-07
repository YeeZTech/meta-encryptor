const meta = require("../src/index.js");
import {Sealer, ToString} from "../src/Sealer"
import {Unsealer} from "../src/Unsealer"

const {PipelineContextInFile} = require("../src/PipelineConext.js")
const {RecoverableReadStream, RecoverableWriteStream} = require("../src/Recoverable.js")
import fs from "fs";
import{calculateMD5, key_pair, generateFileWithSize} from "./helper"

const path = require('path');
async function sealFile(src){
    let dst = path.join(path.dirname(src), path.basename(src) + ".sealed");
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
    return dst
}
async function compare(src, ret_src){
    let m1 = await calculateMD5(src)
    let m2 = await calculateMD5(ret_src);
    expect(m1.length > 0).toBe(true)
    expect(m1).toStrictEqual(m2);
}

test('test pipeline context basic', async ()=>{
    //let src = "Unsealerlarge.file";
    //let src = './rollup.config.js'
    let src = './tsconfig.json'
    let context_path = "test_context";

    try{
        //fs.unlinkSync(src)
        fs.unlinkSync(context_path)
      }catch(error){}
    let dst = await sealFile(src);
    let ret_src = path.join(path.dirname(src), path.basename(src) + ".sealed.ret")

    
    let context = new PipelineContextInFile(context_path)
    context.loadContext();
    let rs = new RecoverableReadStream(dst, context)
    let ws = new RecoverableWriteStream(ret_src, context)
    let unsealer = new meta.Unsealer({keyPair: key_pair});
    rs.pipe(unsealer).pipe(ws);

    await new Promise((resolve)=>{
        ws.on('finish', ()=>{
          resolve();
        });
      });

    await compare(src, ret_src)

    fs.unlinkSync(context_path)
    fs.unlinkSync(ret_src)
})



test('test pipeline context large', async ()=>{
  let src = "Unsealerlarge.file";
  //let src = './rollup.config.js'
  //let src = './tsconfig.json'
  let context_path = "test_context";
  try{
      fs.unlinkSync(src)
      fs.unlinkSync(context_path)
    }catch(error){}
    //100MB
  generateFileWithSize(src,  1024 * 1024 * 100)
  let dst = await sealFile(src);
  let ret_src = path.join(path.dirname(src), path.basename(src) + ".sealed.ret")

  
  let context = new PipelineContextInFile(context_path)
  context.loadContext();
  let rs = new RecoverableReadStream(dst, context)
  let ws = new RecoverableWriteStream(ret_src, context)
  let unsealer = new meta.Unsealer({keyPair: key_pair});
  rs.pipe(unsealer).pipe(ws);

  await new Promise((resolve)=>{
      ws.on('finish', ()=>{
        resolve();
      });
    });

  await compare(src, ret_src)

  fs.unlinkSync(src)
  fs.unlinkSync(context_path)
  fs.unlinkSync(ret_src)
})



test('test pipeline context large same file', async ()=>{
  let src = "Unsealerlarge.file";
  //let src = './rollup.config.js'
  //let src = './tsconfig.json'
  let context_path = "test_context";
  try{
      fs.unlinkSync(src)
      fs.unlinkSync(context_path)
    }catch(error){}
    //100MB
  generateFileWithSize(src,  1024 * 1024 * 100)
  console.log("aaaa")
  let dst = await sealFile(src);
  console.log("bb")
  let ret_src = src

  console.log("ccc")
  let m1 = await calculateMD5(src)
  
  
  let context = new PipelineContextInFile(context_path)
  context.loadContext();
  console.log("ddd")
  let rs = new RecoverableReadStream(dst, context)
  let ws = new RecoverableWriteStream(ret_src, context)
  let unsealer = new meta.Unsealer({keyPair: key_pair});
  rs.pipe(unsealer).pipe(ws);

  await new Promise((resolve)=>{
      ws.on('finish', ()=>{
        resolve();
      });
    });

  let m2 = await calculateMD5(ret_src);
  expect(m1.length > 0).toBe(true)
  expect(m1).toStrictEqual(m2);

  fs.unlinkSync(src)
  fs.unlinkSync(context_path)
  //fs.unlinkSync(ret_src)
})

import { SealedFileStream } from "../src/SealedFileStream"
import fs from "fs";
import path from "path";
import{ calculateMD5, generateFileWithSize, key_pair } from "./helper"
import { Sealer } from "../src/Sealer"

test('test SealedFileStream on("readable")', async()=>{
  const src = "SealedFileStream.xlarge.file";
  const copyFilePath = "SealedFileStream.xlarge.file.copy";
  let dst = path.join(path.dirname(src), path.basename(src) + ".sealed");
  try{
    fs.unlinkSync(src)
    fs.unlinkSync(dst)
    fs.unlinkSync(copyFilePath)
  }catch(error){

  }

  const fileSize = 1024 * 1024 * 100;

  generateFileWithSize(src,  fileSize)


  await new Promise((resolve)=>{
    let rs = fs.createReadStream(src)
    let ws = fs.createWriteStream(dst)
    ws.on('finish', ()=>{
      resolve();
    });
    rs.pipe(new Sealer({keyPair: key_pair})).pipe(ws)
  });
  
  await new Promise((resolve)=>{
    const sealedStream = new SealedFileStream(dst, {start: 0});

    const writeStream = fs.createWriteStream(copyFilePath, {flags: "a"});
    sealedStream.on('readable', function() {
      let chunk;
      while ((chunk = this.read()) !== null) {
        writeStream.write(chunk);
      }
    })
    sealedStream.on('end', ()=>{
      writeStream.end();
    })
    writeStream.on('close', ()=>{
      sealedStream.destroy()
      resolve();
    })
  });

  let size = fs.statSync(copyFilePath).size;
  expect(size > fileSize).toBe(true)
  fs.unlinkSync(src)
  fs.unlinkSync(dst)
  fs.unlinkSync(copyFilePath)
})

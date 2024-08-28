import { RemoteSealedFileStream } from "../src/RemoteSealedFileStream"
import fs from "fs";
import path from "path";
import{ generateFileWithSize, key_pair, tusConfig } from "./helper"
import { Sealer } from "../src/Sealer"

const tusDownloadUrl = tusConfig.downloadUrl

const tusFileDir = tusConfig.tusFileDir

test('test RemoteSealedFileStream on("readable")', async()=>{
  const src = "test.remoteSealedFileStream.file";
  const copyFilePath = src + ".copy";
  const sealFileName = path.basename(src) + ".sealed"
  const dst = path.join(tusFileDir, sealFileName);
  try{
    fs.unlinkSync(src)
    fs.unlinkSync(dst)
    fs.unlinkSync(copyFilePath)
  }catch(error){

  }

  const fileSize = 1024 * 1024 * 5;

  generateFileWithSize(src,  fileSize)


  await new Promise((resolve)=>{
    let rs = fs.createReadStream(src)
    let ws = fs.createWriteStream(dst)
    ws.on('finish', ()=>{
      resolve();
    });
    rs.pipe(new Sealer({keyPair: key_pair})).pipe(ws)
  });
  
  await new Promise((resolve, reject)=>{
    const RemoteSealedStream = new RemoteSealedFileStream(sealFileName, tusDownloadUrl, {start: 0});

    const writeStream = fs.createWriteStream(copyFilePath, {flags: "a"});
    RemoteSealedStream.on('readable', function() {
      let chunk;
      while ((chunk = this.read()) !== null) {
        writeStream.write(chunk);
      }
    })
    RemoteSealedStream.on('end', ()=>{
      writeStream.end();
    })
    RemoteSealedStream.on('error', (e) => {
      reject(e)
    })
    writeStream.on('close', ()=>{
      RemoteSealedStream.destroy()
      resolve();
    })
  });

  let size = fs.statSync(copyFilePath).size;
  expect(size > fileSize).toBe(true)
  fs.unlinkSync(src)
  fs.unlinkSync(dst)
  fs.unlinkSync(copyFilePath)
})

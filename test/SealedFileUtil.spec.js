
import {Sealer, ToString} from "../src/node/Sealer"
import {isSealedFile, sealedFileVersion, dataHashOfSealedFile, signedDataHash, forwardData} from "../src/node/SealedFileUtil.js"


const path = require('path');
import fs from "fs";

import{calculateMD5, key_pair, copyRepoFileToTest} from "./helper"

test('true', async()=>{
  let src = copyRepoFileToTest('./package.json');
  let dst = path.join(path.dirname(src), path.basename(src) + ".util.sealed");
  let rs = fs.createReadStream(src)
  let ws = fs.createWriteStream(dst)

  rs.pipe(new Sealer({keyPair: key_pair})).pipe(ws)
  await new Promise((resolve)=>{
    ws.on('finish', ()=>{
      resolve();
    });
  });

  let t = isSealedFile(src);
  expect(t).toBe(false);
  let t2 = isSealedFile(dst);
  expect(t2).toBe(true);
  let t3 = sealedFileVersion(dst);
  expect(t3).toBe(2);
  let hash = dataHashOfSealedFile(dst);
  expect(hash.length).toBe(32);
  let s = signedDataHash(key_pair, hash);
  expect(s.length != 0).toBe(true);
  fs.unlinkSync(dst);
})

const openFdCount = () => fs.readdirSync('/dev/fd').length;
const testWithFdList = process.platform === 'win32' ? test.skip : test;

testWithFdList('header readers close their file handle', async () => {
  const src = copyRepoFileToTest('./package.json');
  const dst = path.join(path.dirname(src), path.basename(src) + ".fd.sealed");
  const ws = fs.createWriteStream(dst);
  fs.createReadStream(src).pipe(new Sealer({ keyPair: key_pair })).pipe(ws);
  await new Promise((resolve) => ws.on('close', resolve));

  const before = openFdCount();
  for (let i = 0; i < 20; i++) {
    expect(isSealedFile(dst)).toBe(true);
    expect(sealedFileVersion(dst)).toBe(2);
    expect(dataHashOfSealedFile(dst).length).toBe(32);
  }
  expect(isSealedFile(src)).toBe(false);
  expect(openFdCount()).toBe(before);
  fs.unlinkSync(dst);
})

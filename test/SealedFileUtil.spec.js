
import {Sealer, ToString} from "../src/Sealer"
import {isSealedFile, sealedFileVersion, dataHashOfSealedFile, signedDataHash, forwardData} from "../src/SealedFileUtil.js"


const path = require('path');
import fs from "fs";

import{calculateMD5, key_pair} from "./helper"

test('true', async()=>{
  let src = './package.json';
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

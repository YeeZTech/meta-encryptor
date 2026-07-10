
import {Sealer, ToString} from "../src/node/Sealer"
import {
  isSealedFile,
  sealedFileVersion,
  dataHashOfSealedFile,
  signedDataHash,
  calculateSealedHash
} from "../src/node/SealedFileUtil.js"


const path = require('path');
import fs from "fs";

import{calculateMD5, key_pair, copyRepoFileToTest} from "./helper"
import { testPath } from './tempRegistry.cjs';

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

test('calculateSealedHash rejects oversized item lengths before allocation', async () => {
  const target = testPath('sealed-hash-corrupt.sealed');
  const chunks = [];
  const sealer = new Sealer({ keyPair: key_pair });
  sealer.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    sealer.on('end', resolve);
    sealer.on('error', reject);
  });
  sealer.end(Buffer.from('hash me'));
  await done;
  const sealed = Buffer.concat(chunks);
  sealed.writeBigUInt64LE(0xffffffffffffffffn, 0);
  fs.writeFileSync(target, sealed);

  expect(() => calculateSealedHash(target)).toThrow(
    expect.objectContaining({ code: 'ERR_INVALID_FORMAT' })
  );
});

test('header inspection closes descriptors on non-sealed files', () => {
  const target = testPath('not-sealed.txt');
  fs.writeFileSync(target, Buffer.alloc(128, 0xff));
  expect(isSealedFile(target)).toBe(false);
  expect(() => fs.unlinkSync(target)).not.toThrow();
});

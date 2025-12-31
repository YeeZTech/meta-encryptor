import streams from 'memory-streams';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// use built commonjs bundle to avoid ESM/CJS interop issues
const built = require('../../build/commonjs/index.cjs');
const { DataProvider, YPCCrypto } = built;

const HeaderSize = 64;
const BlockInfoSize = 32;

async function main(){
  const sk = YPCCrypto.generatePrivateKey();
  const pk = YPCCrypto.generatePublicKeyFromPrivateKey(sk);
  const keyPair = { private_key: sk.toString('hex'), public_key: pk.toString('hex') };

  const dp = new DataProvider(keyPair);
  const ws = new streams.WritableStream();

  const samples = [
    'Hello, World!\n',
    'Meta-Encryptor Browser Unsealer Test\n',
    '一二三四五六七八九十\n',
  ];
  for(const s of samples){ dp.sealData(s, ws, false); }
  dp.sealData(null, ws, true);
  const diskBuf = ws.toBuffer();

  // extract header (last 64 bytes) and compute contentSize using block_number
  if(diskBuf.length <= HeaderSize){ throw new Error('invalid sealed buffer'); }
  const header = diskBuf.subarray(diskBuf.length - HeaderSize);
  const bb = ByteBuffer.wrap(header, LITTLE_ENDIAN);
  const block_number = bb.readUint64(16).toNumber();
  const contentSize = diskBuf.length - HeaderSize - BlockInfoSize * block_number;
  const content = diskBuf.slice(0, contentSize);
  const streamBuf = Buffer.concat([header, content]);

  const outDir = path.resolve(process.cwd(), 'example', 'browser');
  if(!fs.existsSync(outDir)) fs.mkdirSync(outDir, {recursive:true});
  const sealedPath = path.join(outDir, 'sealed_full.bin');
  const streamPath = path.join(outDir, 'stream.bin');
  const keyPath = path.join(outDir, 'keys.json');
  fs.writeFileSync(sealedPath, diskBuf);
  fs.writeFileSync(streamPath, streamBuf);
  fs.writeFileSync(keyPath, JSON.stringify(keyPair, null, 2));

  console.log('[gen] wrote:', {sealedPath, streamPath, keyPath});
  console.log('[gen] private_key:', keyPair.private_key);
}

main().catch(e=>{ console.error(e); process.exit(1); });

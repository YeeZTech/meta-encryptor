import fs from 'fs';
import path from 'path';
import streams from 'memory-streams';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const built = require('../build/commonjs/index.node.cjs');
const {Sealer, YPCCrypto, SealedFileStream } = built;


function generateFileWithSize(fp, size){
  let b = Buffer.alloc(1024 * 64);
  for(let i = 0; i < 1024 * 64; i++){
    b[i] = i%256
  }

  for (let i = 0; i < size/(1024 * 64); i++) {
    fs.writeFileSync(fp,
      b,
      {
        flag: "a+",
        mode: 0o666
      });
  }
}

const root = path.resolve(new URL(import.meta.url).pathname, '..');
const repoRoot = path.resolve(root, '..');
const outDir = path.join(repoRoot, 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });


async function genSmallFile(filename, size, fixtureJsonName){
  const srcPlain = path.join(outDir, filename);
  const fixtureJsonPath = path.join(outDir, fixtureJsonName);
  generateFileWithSize(srcPlain, size);
  
  const sk = YPCCrypto.generatePrivateKey();
  const pk = YPCCrypto.generatePublicKeyFromPrivateKey(sk);
  const keyPair = { private_key: sk.toString('hex'), public_key: pk.toString('hex') };
  // create sealed file by streaming through Sealer
  const sealedPath = path.join(outDir, filename + '.sealed.temp');
  const rs = fs.createReadStream(srcPlain);
  const ws = fs.createWriteStream(sealedPath);
  const sealer = new Sealer({ keyPair });
  await new Promise((resolve, reject) => {
    rs.pipe(sealer).pipe(ws).on('finish', resolve).on('error', reject);
  });

  const finalSealedPath = path.join(outDir, filename + '.sealed');
  const rss = new SealedFileStream(sealedPath);
  const wss = fs.createWriteStream(finalSealedPath);
  await new Promise((resolve, reject) => {
    rss.pipe(wss).on('finish', resolve).on('error', reject);
  });
  fs.unlinkSync(sealedPath);

  const fixture = {
    private_key_hex: keyPair.private_key,
    public_key_hex: keyPair.public_key,
    plain_path: srcPlain,
    sealed_path: finalSealedPath,
  };

  fs.writeFileSync(fixtureJsonPath, JSON.stringify(fixture, null, 2));
}
async function main(){
  await genSmallFile('browser-unsealer-small.file', 1024 * 10, 'browser-unsealer-fixture-small.json');
  await genSmallFile('browser-unsealer-medium.file', 1024 * 1024 * 20, 'browser-unsealer-fixture-medium.json');
}

main().catch(err=>{ console.error(err); process.exit(1); });

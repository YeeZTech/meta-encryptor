/**
 * Node 侧 keccak 原语：默认原生优先；可注入；可被环境变量关掉。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { keccak_256 as keccakJs } from '@noble/hashes/sha3';
import {
  Sealer,
  Unsealer,
  PipelineContextInFile,
  RecoverableReadStream,
  RecoverableWriteStream,
  calculateSealedHash,
  getKeccakImplementation,
  YPCCrypto,
} from '../src/index.node.js';

const require = createRequire(path.join(process.cwd(), 'package.json'));

function makeKeyPair() {
  const ypc = typeof YPCCrypto === 'function' ? YPCCrypto() : YPCCrypto;
  const skey = ypc.generatePrivateKey();
  const pkey = ypc.generatePublicKeyFromPrivateKey(skey);
  return {
    private_key: Buffer.from(skey).toString('hex'),
    public_key: Buffer.from(pkey).toString('hex'),
  };
}

function sealToFile(plainPath, sealedPath, keyPair, hashProvider) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(plainPath)
      .pipe(new Sealer({ keyPair, hashProvider }))
      .pipe(fs.createWriteStream(sealedPath))
      .on('finish', resolve)
      .on('error', reject);
  });
}

function unsealToFile(sealedPath, outPath, keyPair, hashProvider) {
  return new Promise(async (resolve, reject) => {
    const progressPath = outPath + '.progress';
    const context = new PipelineContextInFile(progressPath);
    await context.loadContext();
    const read = new RecoverableReadStream(sealedPath, context);
    const unsealer = new Unsealer({ keyPair, context, hashProvider });
    const write = new RecoverableWriteStream(outPath, context);
    read.on('error', reject);
    unsealer.on('error', reject);
    write.on('error', reject);
    write.on('finish', resolve);
    read.pipe(unsealer).pipe(write);
  });
}

test('uses native keccak when optionalDependency keccak is installed', () => {
  const impl = getKeccakImplementation();
  expect(impl === 'native' || impl === 'js').toBe(true);
  // 本机装了 keccak 且没强制关掉时，必须走原生（5.0.7 起的默认行为）
  if (process.env.META_ENCRYPTOR_DISABLE_NATIVE_KECCAK === '1') {
    expect(impl).toBe('js');
    return;
  }
  try {
    require('keccak');
  } catch {
    expect(impl).toBe('js');
    return;
  }
  expect(impl).toBe('native');
});

test('Sealer/Unsealer with injected hashProvider round-trips and matches calculateSealedHash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-keccak-'));
  const plainPath = path.join(dir, 'plain.bin');
  const sealedPath = path.join(dir, 'sealed.bin');
  const outPath = path.join(dir, 'out.bin');
  const plain = Buffer.alloc(256 * 1024, 7);
  fs.writeFileSync(plainPath, plain);

  let calls = 0;
  const hashProvider = {
    keccak256(data) {
      calls += 1;
      return keccakJs(data);
    },
  };

  const keyPair = makeKeyPair();
  await sealToFile(plainPath, sealedPath, keyPair, hashProvider);
  expect(calls).toBeGreaterThan(0);

  const expectedHash = calculateSealedHash(sealedPath, { hashProvider });
  await unsealToFile(sealedPath, outPath, keyPair, hashProvider);
  expect(fs.readFileSync(outPath).equals(plain)).toBe(true);
  expect(calculateSealedHash(sealedPath)).toBe(expectedHash);

  fs.rmSync(dir, { recursive: true, force: true });
});

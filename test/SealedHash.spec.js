import fs from 'fs';
import os from 'os';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';

import { Sealer } from '../src/node/Sealer.js';
import { dataHashOfSealedFile } from '../src/node/SealedFileUtil.js';
import { calculateSealedHash, calculateSealedHashAsync } from '../src/node/SealedHash.js';
import { key_pair } from './helper';

const path = require('path');

const MB = 1024 * 1024;
const PLAIN_SIZE = 4 * MB;

let dir;
let plainPath;
let sealedPath;
let expectedHash;

/**
 * 参照实现：逐 item 单独 read + Buffer.concat + 一次性 keccak256，
 * 与重构前 5.0.6 的算法逐字节一致，用来钉死重构后的口径。
 */
function referenceSealedHash(filePath) {
  const fileSize = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, fileSize - 64);
    const itemCount = Number(header.readBigUInt64LE(24));

    let hash = Buffer.from(keccak256(Buffer.from('Fidelius', 'utf-8')));
    let offset = 0;
    for (let i = 0; i < itemCount; i++) {
      const lengthBuffer = Buffer.alloc(8);
      fs.readSync(fd, lengthBuffer, 0, 8, offset);
      const itemLength = Number(lengthBuffer.readBigUInt64LE(0));
      offset += 8;

      const item = Buffer.alloc(itemLength);
      fs.readSync(fd, item, 0, itemLength, offset);
      hash = Buffer.from(keccak256(Buffer.concat([hash, item])));
      offset += itemLength;
    }
    return hash.toString('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function seal(src, dst) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dst);
    ws.on('finish', resolve);
    ws.on('error', reject);
    fs.createReadStream(src)
      .pipe(new Sealer({ keyPair: key_pair }))
      .pipe(ws);
  });
}

beforeAll(async () => {
  // 不走 helper.testPath：那里注册的临时文件会被 afterEach 清掉，而这份 fixture 要跨用例复用
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-sealed-hash-'));
  plainPath = path.join(dir, 'plain.bin');
  sealedPath = path.join(dir, 'plain.bin.sealed');

  const block = Buffer.allocUnsafe(64 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) % 256;
  const fd = fs.openSync(plainPath, 'w');
  for (let written = 0; written < PLAIN_SIZE; written += block.length) {
    fs.writeSync(fd, block);
  }
  fs.closeSync(fd);

  await seal(plainPath, sealedPath);
  expectedHash = referenceSealedHash(sealedPath);
}, 120000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同步版与参照实现、与文件头 data_hash 一致，且不依赖 Buffer.prototype.readUint64', () => {
  // 5.0.6 里调的是不存在的 Buffer.prototype.readUint64，调用方必须自己打 polyfill
  expect(typeof Buffer.prototype.readUint64).toBe('undefined');

  const hash = calculateSealedHash(sealedPath);
  expect(hash).toBe(expectedHash);
  // 与文件头里的 data_hash 不同口径：那个是封装侧对明文的哈希，这里扫的是 sealed item
  expect(hash).not.toBe(dataHashOfSealedFile(sealedPath).toString('hex'));
});

test('异步版结果与同步版一致，并上报单调递增的进度与断点', async () => {
  const progresses = [];
  const checkpoints = [];

  const hash = await calculateSealedHashAsync(sealedPath, {
    yieldEveryBytes: 64 * 1024,
    onProgress: (p) => progresses.push(p),
    onCheckpoint: (cp) => checkpoints.push(cp),
  });

  expect(hash).toBe(expectedHash);
  expect(progresses.length).toBeGreaterThan(2);
  expect(checkpoints.length).toBe(progresses.length);

  const first = progresses[0];
  const last = progresses[progresses.length - 1];
  expect(first.bytesRead).toBe(0);
  expect(first.itemIndex).toBe(0);
  expect(last.itemIndex).toBe(last.itemCount);
  // totalBytes 是数据区上界，尾部有少量不属于任何 item 的字节，所以终值略小于 1
  expect(last.progress).toBeGreaterThan(0.999);
  expect(last.progress).toBeLessThanOrEqual(1);
  expect(last.totalBytes).toBe(fs.statSync(sealedPath).size - 64);

  for (let i = 1; i < progresses.length; i++) {
    expect(progresses[i].bytesRead).toBeGreaterThanOrEqual(progresses[i - 1].bytesRead);
    expect(progresses[i].itemIndex).toBeGreaterThanOrEqual(progresses[i - 1].itemIndex);
  }
  // 最后一次断点即完整哈希
  expect(checkpoints[checkpoints.length - 1].hash).toBe(expectedHash);
});

test('异步扫描期间事件循环仍在转（同步版会整段阻塞）', async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 2);
  try {
    await calculateSealedHashAsync(sealedPath, { yieldEveryBytes: 64 * 1024 });
  } finally {
    clearInterval(timer);
  }
  expect(ticks).toBeGreaterThan(3);
});

test('取消后可用断点续算，结果与一次算完相同', async () => {
  const controller = new AbortController();
  let abortCheckpoint = null;

  const aborted = calculateSealedHashAsync(sealedPath, {
    yieldEveryBytes: 64 * 1024,
    signal: controller.signal,
    onCheckpoint: (cp) => {
      if (cp.itemIndex >= 2 && !controller.signal.aborted) {
        abortCheckpoint = cp;
        controller.abort();
      }
    },
  });

  await expect(aborted).rejects.toMatchObject({ code: 'ERR_SEALED_HASH_ABORTED' });
  await aborted.catch((e) => {
    expect(e.detail.checkpoint.itemIndex).toBeGreaterThan(0);
  });

  expect(abortCheckpoint).not.toBeNull();
  expect(abortCheckpoint.itemIndex).toBeLessThan(abortCheckpoint.itemCount);

  const resumedProgress = [];
  const resumed = await calculateSealedHashAsync(sealedPath, {
    checkpoint: abortCheckpoint,
    yieldEveryBytes: 64 * 1024,
    onProgress: (p) => resumedProgress.push(p),
  });

  expect(resumed).toBe(expectedHash);
  // 续算从断点处起步，而不是从 0 重扫
  expect(resumedProgress[0].itemIndex).toBe(abortCheckpoint.itemIndex);
  expect(resumedProgress[0].bytesRead).toBe(abortCheckpoint.offset);
});

test('已取消的 signal 传入时立即抛错', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    calculateSealedHashAsync(sealedPath, { signal: controller.signal })
  ).rejects.toMatchObject({ code: 'ERR_SEALED_HASH_ABORTED' });
});

test('断点与当前文件不匹配时忽略断点，从头重算', async () => {
  const stale = {
    version: 1,
    fileSize: 12345,
    itemCount: 999,
    itemIndex: 3,
    offset: 128,
    hash: 'a'.repeat(64),
  };
  const first = [];
  const hash = await calculateSealedHashAsync(sealedPath, {
    checkpoint: stale,
    onProgress: (p) => first.push(p),
  });
  expect(hash).toBe(expectedHash);
  expect(first[0].itemIndex).toBe(0);
  expect(first[0].bytesRead).toBe(0);
});

test('注入 hashProvider 时用注入实现，结果与内置一致', async () => {
  const calls = { count: 0 };
  const hashProvider = {
    keccak256(data) {
      calls.count += 1;
      return keccak256(data);
    },
  };

  expect(calculateSealedHash(sealedPath, { hashProvider })).toBe(expectedHash);
  expect(calls.count).toBeGreaterThan(1); // 种子 + 每个 item

  const before = calls.count;
  await expect(
    calculateSealedHashAsync(sealedPath, { hashProvider })
  ).resolves.toBe(expectedHash);
  expect(calls.count).toBeGreaterThan(before);
});

test('文件被截断报 ERR_UNEXPECTED_EOF，文件过小报 ERR_FILE_TOO_SMALL', async () => {
  const truncated = path.join(dir, 'truncated.sealed');
  const full = fs.readFileSync(sealedPath);
  // 保留尾部 header（itemCount 仍是完整文件的），但砍掉一半数据
  const half = Math.floor((full.length - 64) / 2);
  fs.writeFileSync(truncated, Buffer.concat([full.subarray(0, half), full.subarray(-64)]));

  await expect(calculateSealedHashAsync(truncated)).rejects.toMatchObject({
    code: 'ERR_UNEXPECTED_EOF',
  });
  expect(() => calculateSealedHash(truncated)).toThrow(
    expect.objectContaining({ code: 'ERR_UNEXPECTED_EOF' })
  );

  const tooSmall = path.join(dir, 'tiny.sealed');
  fs.writeFileSync(tooSmall, Buffer.alloc(10));
  await expect(calculateSealedHashAsync(tooSmall)).rejects.toMatchObject({
    code: 'ERR_FILE_TOO_SMALL',
  });
  expect(() => calculateSealedHash(tooSmall)).toThrow(
    expect.objectContaining({ code: 'ERR_FILE_TOO_SMALL' })
  );
});

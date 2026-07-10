import { Sealer } from '../src/node/Sealer.js';
import { Unsealer } from '../src/node/Unsealer.js';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';
import YPCCryptoFun from '../src/node/ypccrypto.js';
import {
  batch2ntpackage,
  block_info_t,
  block_info_t2buffer,
  header_t,
  header_t2buffer,
  fromNtInput,
  ntpackage2batch,
  readUint64LE,
  toNtInput,
  writeUint64LE,
} from '../src/common/header_util.js';
import { hexToBytes } from '../src/common/ypccrypto.common.js';
import {
  UnsealerCore,
  tryReadItem,
  validateHeader,
  validateSealedLayout,
} from '../src/common/unsealer_core.js';
import { BlockInfoSize, HeaderSize, MagicNum, MaxItemSize, MaxSealedItemSize } from '../src/common/limits.js';

const keyPair = {
  private_key: '60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8',
  public_key: '731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca',
};
const ypc = YPCCryptoFun();

async function seal(input) {
  const chunks = [];
  const sealer = new Sealer({ keyPair });
  sealer.on('data', (chunk) => chunks.push(chunk));
  await new Promise((resolve, reject) => {
    sealer.on('end', resolve);
    sealer.on('error', reject);
    sealer.end(input);
  });
  const disk = Buffer.concat(chunks);
  const header = disk.subarray(disk.length - HeaderSize);
  const { blockNumber } = validateHeader(header);
  return {
    header,
    content: disk.subarray(0, disk.length - HeaderSize - blockNumber * BlockInfoSize),
  };
}

function splitItems(content) {
  const items = [];
  let offset = 0;
  while (offset < content.length) {
    const size = readUint64LE(content, offset).toNumber();
    items.push(content.subarray(offset, offset + 8 + size));
    offset += 8 + size;
  }
  expect(offset).toBe(content.length);
  return items;
}

async function coreFor(header, content) {
  const output = [];
  const core = new UnsealerCore({
    decrypt: (cipher) => ypc.decryptMessage(Buffer.from(keyPair.private_key, 'hex'), Buffer.from(cipher)),
    onPlain: (plain) => output.push(Buffer.from(plain)),
  });
  await core.processChunk(header);
  if (content.length) await core.processChunk(content);
  return { core, output };
}

function consumeWithNodeUnsealer(options, input) {
  const unsealer = new Unsealer({ keyPair, ...options });
  unsealer.resume();
  return new Promise((resolve, reject) => {
    unsealer.once('finish', resolve);
    unsealer.once('error', reject);
    unsealer.end(input);
  });
}

describe('strict cryptographic inputs', () => {
  test('hex parser supports 0x and rejects odd/non-hex input', () => {
    expect(Buffer.from(hexToBytes('0x00A1ff')).toString('hex')).toBe('00a1ff');
    for (const invalid of ['0x0', 'gg', '12 34']) {
      expect(() => hexToBytes(invalid)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_HEX' }));
    }
  });

  test.each([
    ['pooled Buffer slice', () => Buffer.from('prefix-TARGET-suffix').subarray(7, 13)],
    ['Uint8Array offset view', () => new Uint8Array(Uint8Array.from([9, 9, 1, 2, 3, 9]).buffer, 2, 3)],
    ['DataView offset view', () => new DataView(Uint8Array.from([9, 4, 5, 6, 9]).buffer, 1, 3)],
    ['ArrayBuffer', () => Uint8Array.from([7, 8, 9]).buffer],
    ['legacy wrapper', () => ({ buffer: Buffer.from('wrapped') })],
  ])('generateEncryptedInput encrypts only the %s', (_, makeInput) => {
    const input = makeInput();
    const expected = input?.buffer && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)
      ? Buffer.from(input.buffer)
      : Buffer.from(input instanceof ArrayBuffer
        ? input
        : input.buffer, input.byteOffset || 0, input.byteLength);
    const encrypted = ypc.generateEncryptedInput(Buffer.from(keyPair.public_key, 'hex'), input);
    const plain = ypc.decryptMessage(Buffer.from(keyPair.private_key, 'hex'), encrypted);
    expect(plain).toEqual(expected);
  });
});

describe('strict sealed framing', () => {
  test('u64, nt-package, and nt-input require safe bounded exact framing', () => {
    const unsafe = Buffer.alloc(8, 0xff);
    expect(() => readUint64LE(unsafe, 0)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FORMAT' }));
    expect(() => writeUint64LE(Buffer.alloc(8), 0, Number.MAX_SAFE_INTEGER + 1)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_FORMAT' })
    );

    const nt = toNtInput(Buffer.from('abc'));
    expect(Buffer.from(fromNtInput(nt)).toString()).toBe('abc');
    expect(() => fromNtInput(Buffer.concat([nt, Buffer.from([0])]))).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_FORMAT' })
    );

    const pkg = batch2ntpackage([nt]);
    expect(ntpackage2batch(pkg)).toHaveLength(1);
    expect(() => ntpackage2batch(Buffer.concat([pkg, Buffer.from([0])]))).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_FORMAT' })
    );
    const wrongId = Buffer.from(pkg);
    wrongId.writeUInt32LE(0, 0);
    expect(() => ntpackage2batch(wrongId)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FORMAT' }));
  });

  test('header counts and item lengths are bounded before allocation', async () => {
    const { header } = await seal(Buffer.from('x'));
    const invalidCounts = Buffer.from(header);
    invalidCounts.writeBigUInt64LE(0n, 16);
    expect(() => validateHeader(invalidCounts)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FORMAT' }));

    const oversized = Buffer.alloc(8);
    oversized.writeBigUInt64LE(BigInt(MaxSealedItemSize + 1), 0);
    expect(() => tryReadItem(oversized)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FORMAT' }));
  });

  test('Node consumer allows an explicit cap override for very large historical items', async () => {
    const declaredSize = MaxSealedItemSize + 1;
    const header = new header_t(MagicNum, 2, 1, 1);
    header.data_hash = Buffer.alloc(32);
    const lengthOnly = Buffer.alloc(8);
    lengthOnly.writeBigUInt64LE(BigInt(declaredSize), 0);
    const incompleteItem = Buffer.concat([header_t2buffer(header), lengthOnly]);

    await expect(consumeWithNodeUnsealer({}, incompleteItem)).rejects.toMatchObject({
      code: 'ERR_INVALID_FORMAT'
    });
    await expect(consumeWithNodeUnsealer(
      { maxSealedItemSize: declaredSize },
      incompleteItem
    )).rejects.toMatchObject({ code: 'ERR_TRUNCATED_INPUT' });
    expect(() => new Unsealer({ keyPair, maxSealedItemSize: 0 })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_FORMAT' })
    );
  });

  test('block table must exactly cover declared items and file content', async () => {
    const input = Buffer.alloc(160000, 0x31);
    const chunks = [];
    const sealer = new Sealer({ keyPair });
    sealer.on('data', (chunk) => chunks.push(chunk));
    await new Promise((resolve, reject) => {
      sealer.on('end', resolve);
      sealer.on('error', reject);
      sealer.end(input);
    });
    const disk = Buffer.concat(chunks);
    const header = disk.subarray(-HeaderSize);
    const parsed = validateHeader(header);
    const blockStart = disk.length - HeaderSize - parsed.blockNumber * BlockInfoSize;
    const blocks = disk.subarray(blockStart, disk.length - HeaderSize);
    expect(validateSealedLayout(header, blocks, blockStart, disk.length).contentSize).toBe(blockStart);

    const tampered = Buffer.from(blocks);
    tampered.writeBigUInt64LE(BigInt(blockStart - 1), 24);
    expect(() => validateSealedLayout(header, tampered, blockStart, disk.length)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_FORMAT' })
    );
  });

  test('producer never emits a serialized item over MaxItemSize', async () => {
    const { content } = await seal(Buffer.alloc(5 * MaxItemSize, 0x5a));
    const sizes = splitItems(content).map((item) => readUint64LE(item, 0).toNumber());
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBe(MaxItemSize);
  });

  test('consumer remains compatible with historical v2 items larger than 128 KiB', async () => {
    // HEAD's former Sealer flushed the whole incoming Transform chunk as one
    // item once the 64 KiB threshold was crossed.  Such files are valid v2
    // files even though new producers split them into bounded items.
    const legacyPlain = Buffer.alloc(256 * 1024, 0x6c);
    const rawNt = Buffer.from(toNtInput(legacyPlain));
    const cipher = ypc._encryptMessage(
      Buffer.from(keyPair.public_key, 'hex'),
      ypc.generatePrivateKey(),
      batch2ntpackage([rawNt]),
      0x2
    );
    expect(cipher.length).toBeGreaterThan(128 * 1024);
    expect(cipher.length).toBeLessThanOrEqual(MaxSealedItemSize);

    const dataHash = Buffer.from(keccak256(Buffer.concat([
      Buffer.from(keccak256(Buffer.from('Fidelius'))),
      rawNt,
    ])));
    const header = new header_t(MagicNum, 2, 1, 1);
    header.data_hash = dataHash;
    const item = Buffer.alloc(8 + cipher.length);
    item.writeBigUInt64LE(BigInt(cipher.length), 0);
    cipher.copy(item, 8);

    const headerBytes = header_t2buffer(header);
    const blockInfo = block_info_t2buffer(new block_info_t(0, 1, 0, item.length));
    expect(validateSealedLayout(
      headerBytes,
      blockInfo,
      item.length,
      item.length + blockInfo.length + headerBytes.length
    ).contentSize).toBe(item.length);

    const result = await coreFor(headerBytes, item);
    expect(result.core.finalize().totalItems).toBe(1);
    expect(Buffer.concat(result.output)).toEqual(legacyPlain);
  });
});

describe('UnsealerCore final integrity', () => {
  test('accepts exact content, including a valid zero-item file', async () => {
    const normal = await seal(Buffer.from('roundtrip'.repeat(10000)));
    const { core, output } = await coreFor(normal.header, normal.content);
    expect(core.finalize().totalItems).toBeGreaterThan(0);
    expect(Buffer.concat(output)).toEqual(Buffer.from('roundtrip'.repeat(10000)));

    const empty = await seal(Buffer.alloc(0));
    const emptyCore = await coreFor(empty.header, empty.content);
    expect(emptyCore.core.finished).toBe(true);
    expect(emptyCore.core.finalize().totalItems).toBe(0);
  });

  test('rejects header hash tampering and authenticated item reordering', async () => {
    const source = Buffer.alloc(160000);
    for (let i = 0; i < source.length; i++) source[i] = Math.floor(i / 60000) + 1;
    const sealed = await seal(source);
    const badHash = Buffer.from(sealed.header);
    badHash[32] ^= 1;
    const hashCore = await coreFor(badHash, sealed.content);
    expect(() => hashCore.core.finalize()).toThrow(expect.objectContaining({ code: 'ERR_INTEGRITY_MISMATCH' }));

    const items = splitItems(sealed.content);
    expect(items.length).toBeGreaterThan(1);
    const reordered = Buffer.concat([items[1], items[0], ...items.slice(2)]);
    const reorderCore = await coreFor(sealed.header, reordered);
    expect(() => reorderCore.core.finalize()).toThrow(expect.objectContaining({ code: 'ERR_INTEGRITY_MISMATCH' }));
  });

  test('rejects lowered item counts, truncation, and trailing bytes', async () => {
    const sealed = await seal(Buffer.alloc(160000, 4));
    const lowered = Buffer.from(sealed.header);
    const count = lowered.readBigUInt64LE(24);
    lowered.writeBigUInt64LE(count - 1n, 24);
    lowered.writeBigUInt64LE((count - 2n) / 256n + 1n, 16);
    await expect(coreFor(lowered, sealed.content)).rejects.toMatchObject({ code: 'ERR_INVALID_FORMAT' });

    const truncated = await coreFor(sealed.header, sealed.content.subarray(0, sealed.content.length - 1));
    expect(() => truncated.core.finalize()).toThrow(expect.objectContaining({ code: 'ERR_TRUNCATED_INPUT' }));

    await expect(coreFor(sealed.header, Buffer.concat([sealed.content, Buffer.from([0])]))).rejects.toMatchObject({
      code: 'ERR_INVALID_FORMAT',
    });
  });
});

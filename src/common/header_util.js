// Common header utilities usable in both Node and browser.
// Works with Buffer (Node) and Uint8Array (browser) since Buffer is a Uint8Array subclass.

import { MetaEncryptorError } from './errors.js';
import { Buffer } from 'buffer';

export const NtPackageId = 0x82c4e8d8;
export const NtInputId = 0;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  try {
    return new Uint8Array(value);
  } catch (cause) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', { cause });
  }
}

function requireRange(buffer, offset, length, field) {
  const buf = asBytes(buffer);
  if (!Number.isInteger(offset) || offset < 0 ||
      !Number.isInteger(length) || length < 0 ||
      offset + length > buf.byteLength) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field, offset, length, available: buf.byteLength }
    });
  }
  return buf;
}

function requireSafeUnsigned(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field, value: String(value) }
    });
  }
  return value;
}

function readUint64LE(buffer, offset) {
  const buf = requireRange(buffer, offset, 8, 'uint64');
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const lo = dv.getUint32(0, true);
  const hi = dv.getUint32(4, true);
  const value = Number(hi) * 0x100000000 + Number(lo);
  requireSafeUnsigned(value, 'uint64');
  return { toNumber: () => value, valueOf: () => value };
}

function writeUint64LE(buffer, offset, value) {
  const buf = requireRange(buffer, offset, 8, 'uint64');
  requireSafeUnsigned(value, 'uint64');
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const lo = Number(BigInt(value) & 0xffffffffn);
  const hi = Number(BigInt(value) >> 32n);
  dv.setUint32(0, lo, true);
  dv.setUint32(4, hi, true);
}

function readUint32LE(buffer, offset) {
  const buf = requireRange(buffer, offset, 4, 'uint32');
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
  return dv.getUint32(0, true);
}

function writeUint32LE(buffer, offset, value) {
  const buf = requireRange(buffer, offset, 4, 'uint32');
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'uint32', value: String(value) }
    });
  }
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
  dv.setUint32(0, value, true);
}

function fromNtInput(inputNt) {
  const bytes = asBytes(inputNt);
  if (bytes.byteLength < 12 || readUint32LE(bytes, 0) !== NtInputId) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'ntInput', length: bytes.byteLength }
    });
  }
  const declaredLength = readUint64LE(bytes, 4).toNumber();
  if (declaredLength !== bytes.byteLength - 12) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: {
        field: 'ntInputLength',
        declaredLength,
        actualLength: bytes.byteLength - 12,
      }
    });
  }
  return bytes.subarray(12);
}

function toNtInput(input) {
  // input: string or Buffer/Uint8Array
  const inputBuf = Buffer.isBuffer(input)
    ? input
    : (typeof input === 'string' ? new TextEncoder().encode(input) : asBytes(input));
  const byteLen = inputBuf.byteLength;
  const buf = Buffer.alloc(4 + 8 + byteLen);
  writeUint32LE(buf, 0, NtInputId);
  // write size at offset 4
  writeUint64LE(buf, 4, byteLen);
  // copy input at offset 12
  if (buf.set) {
    buf.set(inputBuf, 12);
  } else {
    for (let i = 0; i < inputBuf.length; i++) buf[12 + i] = inputBuf[i];
  }
  return buf;
}

function ntpackage2batch(pkg) {
  const bytes = asBytes(pkg);
  if (bytes.byteLength < 12 || readUint32LE(bytes, 0) !== NtPackageId) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'ntPackage', length: bytes.byteLength }
    });
  }
  const batch = [];
  let offset = 4; // skip package id
  const cnt = readUint64LE(bytes, offset).toNumber();
  offset += 8;
  // Every item requires at least an eight-byte length field.  This also
  // rejects hostile counts before entering a long loop.
  if (cnt > Math.floor((bytes.byteLength - offset) / 8)) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'ntPackageCount', count: cnt, available: bytes.byteLength - offset }
    });
  }
  for (let i = 0; i < cnt; i++) {
    const len = readUint64LE(bytes, offset).toNumber();
    offset += 8;
    if (len > bytes.byteLength - offset) {
      throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
        detail: { field: 'ntPackageItemLength', itemIndex: i, length: len, available: bytes.byteLength - offset }
      });
    }
    const item = bytes.subarray(offset, offset + len);
    batch.push(item);
    offset += len;
  }
  if (offset !== bytes.byteLength) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'ntPackageTrailingBytes', trailingBytes: bytes.byteLength - offset }
    });
  }
  return batch;
}

function batch2ntpackage(batch) {
  // calculate size
  let buf_size = 4 + 8;
  const items = batch.map(it => {
    if (typeof it === 'string') return new TextEncoder().encode(it);
    if (Buffer.isBuffer(it)) return it;
    return asBytes(it);
  });
  for (let i = 0; i < items.length; i++) {
    buf_size += 8;
    buf_size += items[i].length;
  }
  requireSafeUnsigned(buf_size, 'ntPackageSize');
  const buf = Buffer.alloc(buf_size);
  let offset = 0;
  // package id
  writeUint32LE(buf, offset, NtPackageId);
  offset += 4;
  // batch size
  writeUint64LE(buf, offset, items.length);
  offset += 8;
  for (let i = 0; i < items.length; i++) {
    writeUint64LE(buf, offset, items[i].length);
    offset += 8;
    if (buf.set) buf.set(items[i], offset); else for (let j = 0; j < items[i].length; j++) buf[offset + j] = items[i][j];
    offset += items[i].length;
  }
  return buf;
}

// header and block info structures (originally in src/header_util.js)
export const header_t = function(magic_number, version_number, block_number, item_number) {
  if (new.target == undefined) {
    throw new MetaEncryptorError('ERR_MUST_USE_NEW', { detail: { name: 'header_t' } });
  }
  this.magic_number = magic_number;
  this.version_number = version_number;
  this.block_number = block_number;
  this.item_number = item_number;
  this.data_hash = Buffer.alloc(32);
}

export const header_t2buffer = function(header) {
  const buf = Buffer.alloc(64);
  const magic = Buffer.isBuffer(header.magic_number) ? header.magic_number : Buffer.from(header.magic_number || []);
  if (magic.length !== 8) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'magic', length: magic.length } });
  }
  magic.copy(buf, 0);
  writeUint64LE(buf, 8, header.version_number ?? 0);
  writeUint64LE(buf, 16, header.block_number ?? 0);
  writeUint64LE(buf, 24, header.item_number ?? 0);
  if (!header.data_hash || header.data_hash.length !== 32) {
    throw new MetaEncryptorError('ERR_INVALID_HEADER_HASH');
  }
  Buffer.from(header.data_hash).copy(buf, 32, 0, 32);
  return buf;
}

export const buffer2header_t = function(buf_header) {
  const bytes = requireRange(buf_header, 0, 64, 'header');
  if (bytes.byteLength !== 64) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'headerLength', length: bytes.byteLength } });
  }
  let hd = new header_t(0, 0, 0, 0);
  hd.magic_number = Buffer.from(bytes.subarray(0, 8));
  hd.version_number = readUint64LE(bytes, 8).toNumber();
  hd.block_number = readUint64LE(bytes, 16).toNumber();
  hd.item_number = readUint64LE(bytes, 24).toNumber();
  hd.data_hash = Buffer.from(bytes.subarray(32, 64));
  return hd;
}

export function block_info_t(
  start_item_index,
  end_item_index,
  start_file_pos,
  end_file_pos
) {
  if (new.target == undefined) {
    throw new MetaEncryptorError('ERR_MUST_USE_NEW', { detail: { name: 'block_info_t' } });
  }
  this.start_item_index = start_item_index;
  this.end_item_index = end_item_index;
  this.start_file_pos = start_file_pos;
  this.end_file_pos = end_file_pos;
}
export const block_info_t2buffer = function(bi) {
  const buf = Buffer.alloc(32);
  writeUint64LE(buf, 0, bi.start_item_index ?? 0);
  writeUint64LE(buf, 8, bi.end_item_index ?? 0);
  writeUint64LE(buf, 16, bi.start_file_pos ?? 0);
  writeUint64LE(buf, 24, bi.end_file_pos ?? 0);
  return buf;
}
export const buffer2block_info_t = function(buf_header) {
  const bytes = requireRange(buf_header, 0, 32, 'blockInfo');
  if (bytes.byteLength !== 32) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'blockInfoLength', length: bytes.byteLength } });
  }
  let bi = {};
  bi.start_item_index = readUint64LE(bytes, 0).toNumber();
  bi.end_item_index = readUint64LE(bytes, 8).toNumber();
  bi.start_file_pos = readUint64LE(bytes, 16).toNumber();
  bi.end_file_pos = readUint64LE(bytes, 24).toNumber();
  return bi;
}

export {
  readUint64LE,
  writeUint64LE,
  readUint32LE,
  writeUint32LE,
  fromNtInput,
  toNtInput,
  ntpackage2batch,
  batch2ntpackage,
};

// Common header utilities usable in both Node and browser.
// Works with Buffer (Node) and Uint8Array (browser) since Buffer is a Uint8Array subclass.

function readUint64LE(buffer, offset) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const lo = dv.getUint32(0, true);
  const hi = dv.getUint32(4, true);
  const value = Number(hi) * 0x100000000 + Number(lo);
  return { toNumber: () => value, valueOf: () => value };
}

function writeUint64LE(buffer, offset, value) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const lo = Number(BigInt(value) & 0xffffffffn);
  const hi = Number(BigInt(value) >> 32n);
  dv.setUint32(0, lo, true);
  dv.setUint32(4, hi, true);
}

function readUint32LE(buffer, offset) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
  return dv.getUint32(0, true);
}

function writeUint32LE(buffer, offset, value) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
  dv.setUint32(0, value, true);
}

function fromNtInput(inputNt) {
  return inputNt.slice(12);
}

function toNtInput(input) {
  // input: string or Buffer/Uint8Array
  const inputBuf = (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) ? input : (typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input));
  const byteLen = inputBuf.length;
  const buf = (typeof Buffer !== 'undefined' && typeof Buffer.alloc === 'function') ? Buffer.alloc(4 + 8 + byteLen) : new Uint8Array(4 + 8 + byteLen);
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
  const batch = [];
  let offset = 4; // skip package id
  const cnt = readUint64LE(pkg, offset).toNumber();
  offset += 8;
  for (let i = 0; i < cnt; i++) {
    const len = readUint64LE(pkg, offset).toNumber();
    offset += 8;
    const item = pkg.slice(offset, offset + len);
    batch.push(item);
    offset += len;
  }
  return batch;
}

function batch2ntpackage(batch) {
  // calculate size
  let buf_size = 4 + 8;
  const items = batch.map(it => {
    if (typeof it === 'string') return new TextEncoder().encode(it);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(it)) return it;
    return new Uint8Array(it);
  });
  for (let i = 0; i < items.length; i++) {
    buf_size += 8;
    buf_size += items[i].length;
  }
  const buf = (typeof Buffer !== 'undefined' && typeof Buffer.alloc === 'function') ? Buffer.alloc(buf_size) : new Uint8Array(buf_size);
  let offset = 0;
  // package id
  if (buf.writeUInt32LE) buf.writeUInt32LE(0x82c4e8d8, offset); else writeUint32LE(buf, offset, 0x82c4e8d8);
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
    throw new Error("header_t must be called with the new keyword");
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
  if (magic.length > 8) magic.copy(buf, 0, 0, 8); else magic.copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(header.version_number || 0), 8);
  buf.writeBigUInt64LE(BigInt(header.block_number || 0), 16);
  buf.writeBigUInt64LE(BigInt(header.item_number || 0), 24);
  if (!header.data_hash || header.data_hash.length !== 32) {
    throw new Error("header.data_hash is invalid");
  }
  header.data_hash.copy(buf, 32, 0, 32);
  return buf;
}

export const buffer2header_t = function(buf_header) {
  let hd = new header_t(0, 0, 0, 0);
  hd.magic_number = Buffer.from(buf_header.slice(0, 8));
  hd.version_number = Number(buf_header.readBigUInt64LE(8));
  hd.block_number = Number(buf_header.readBigUInt64LE(16));
  hd.item_number = Number(buf_header.readBigUInt64LE(24));
  hd.data_hash = Buffer.from(buf_header.slice(32, 64));
  return hd;
}

export function block_info_t(
  start_item_index,
  end_item_index,
  start_file_pos,
  end_file_pos
) {
  if (new.target == undefined) {
    throw new Error("block_info_t must be called with the new keyword");
  }
  this.start_item_index = start_item_index;
  this.end_item_index = end_item_index;
  this.start_file_pos = start_file_pos;
  this.end_file_pos = end_file_pos;
}
export const block_info_t2buffer = function(bi) {
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64LE(BigInt(bi.start_item_index || 0), 0);
  buf.writeBigUInt64LE(BigInt(bi.end_item_index || 0), 8);
  buf.writeBigUInt64LE(BigInt(bi.start_file_pos || 0), 16);
  buf.writeBigUInt64LE(BigInt(bi.end_file_pos || 0), 24);
  return buf;
}
export const buffer2block_info_t = function(buf_header) {
  let bi = {};
  bi.start_item_index = Number(buf_header.readBigUInt64LE(0));
  bi.end_item_index = Number(buf_header.readBigUInt64LE(8));
  bi.start_file_pos = Number(buf_header.readBigUInt64LE(16));
  bi.end_file_pos = Number(buf_header.readBigUInt64LE(24));
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

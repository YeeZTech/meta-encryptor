// 32 bytes
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

// 32 bytes
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

export const toNtInput = function(input) {
  const inputBuf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  const byteLen = inputBuf.length;
  const buf = Buffer.alloc(4 + 8 + byteLen);
  // input size at offset 4
  buf.writeBigUInt64LE(BigInt(byteLen), 4);
  // input at offset 12
  inputBuf.copy(buf, 12);
  //buf.write(input, 12, "utf8");
  return buf;
}

export const fromNtInput = function(inputNt) {
  return inputNt.slice(12);
}

export const batch2ntpackage = function(batch) {
  let buf_size = 4 + 8;
  for (let i = 0; i < batch.length; i++) {
    buf_size += 8;
    buf_size += Buffer.byteLength(batch[i], "utf8");
  }

  const buf = Buffer.alloc(buf_size);
  let offset = 0;
  // package id (uint32)
  buf.writeUInt32LE(0x82c4e8d8, offset);
  offset += 4;
  // batch size (uint64)
  buf.writeBigUInt64LE(BigInt(batch.length), offset);
  offset += 8;
  // batch items
  for (let i = 0; i < batch.length; i++) {
    const byteLen = Buffer.byteLength(batch[i], "utf8");
    buf.writeBigUInt64LE(BigInt(byteLen), offset);
    offset += 8;
    const batchBuf = Buffer.isBuffer(batch[i]) ? batch[i] : Buffer.from(batch[i], "utf8");
    batchBuf.copy(buf, offset);
    //buf.write(batch[i], offset, "utf8");
    offset += byteLen;
  }
  return buf;
}

export const ntpackage2batch = function(pkg) {
  let batch = [];
  let offset = 4;
  const cnt = Number(pkg.readBigUInt64LE(offset));
  offset += 8;
  for (let i = 0; i < cnt; i++) {
    const len = Number(pkg.readBigUInt64LE(offset));
    offset += 8;
    const s = pkg.slice(offset, offset + len);
    batch.push(s);
    offset += len;
  }
  return batch;
}
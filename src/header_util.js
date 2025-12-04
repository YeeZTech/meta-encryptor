import * as ByteBufferNS from "bytebuffer";

const ByteBuffer = /** @type {any} */ (ByteBufferNS);
const LITTLE_ENDIAN = ByteBuffer.LITTLE_ENDIAN;
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
  let buf = new ByteBuffer(64, LITTLE_ENDIAN);
  buf.append(header.magic_number, 0);
  buf.writeUint64(header.version_number, 8);
  buf.writeUint64(header.block_number, 16);
  buf.writeUint64(header.item_number, 24);
  if (header.data_hash.length != 32) {
    throw new Error("header.data_hash is invalid");
  }
  header.data_hash.copy(buf.buffer, 32, 0, 32);
  return buf;
}

export const buffer2header_t = function(buf_header) {
  let hd = new header_t(0, 0, 0, 0);
  hd.magic_number = Buffer.from(buf_header.buffer.subarray(0, 8));
  hd.version_number = buf_header.readUint64(8).toNumber();
  hd.block_number = buf_header.readUint64(16).toNumber();
  hd.item_number = buf_header.readUint64(24).toNumber();
  hd.data_hash = buf_header.buffer.subarray(32, 64);
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
  let buf = new ByteBuffer(32, LITTLE_ENDIAN);
  buf.writeUint64(bi.start_item_index, 0);
  buf.writeUint64(bi.end_item_index, 8);
  buf.writeUint64(bi.start_file_pos, 16);
  buf.writeUint64(bi.end_file_pos, 24);
  return buf;
}
export const buffer2block_info_t = function(buf_header) {
  let bi = {}
  bi.start_item_index = buf_header.readUint64(0).toNumber();
  bi.end_item_index = buf_header.readUint64(8).toNumber();
  bi.start_file_pos = buf_header.readUint64(16).toNumber();
  bi.end_file_pos = buf_header.readUint64(24).toNumber();
  return bi;
}

export const toNtInput = function(input) {
  var byteLen = Buffer.byteLength(input, "utf8");
  let buf = new ByteBuffer(4 + 8 + byteLen, LITTLE_ENDIAN);
  var offset = 4;
  // input size
  buf.writeUint64(byteLen, offset);
  offset += 8;
  // input
  buf.append(input, offset);
  return buf.buffer;
}

export const fromNtInput = function(inputNt) {
  let offset = 12;
  return inputNt.slice(offset, inputNt.length);
}

export const batch2ntpackage = function(batch) {
  var buf_size = 4 + 8;
  for (let i = 0; i < batch.length; i++) {
    buf_size += 8;
    var byteLen = Buffer.byteLength(batch[i], "utf8");
    buf_size += byteLen;
  }

  let buf = new ByteBuffer(buf_size, LITTLE_ENDIAN);
  var offset = 0;
  // package id
  buf.writeUint32(0x82c4e8d8, offset);
  offset += 4;
  //batch size
  buf.writeUint64(batch.length, offset);
  offset += 8;
  //batch items
  for (let i = 0; i < batch.length; i++) {
    var byteLen = Buffer.byteLength(batch[i], "utf8");
    buf.writeUint64(byteLen, offset);
    offset += 8;
    buf.append(batch[i], offset);
    offset += byteLen;
  }
  return buf.buffer;
}

export const ntpackage2batch = function(pkg) {
  let batch = [];
  let buf = new ByteBuffer(pkg.length, LITTLE_ENDIAN);
  buf.append(pkg);
  let offset = 4;
  let cnt = buf.readUint64(offset).toNumber();
  offset += 8;
  for (let i = 0; i < cnt; i++) {
    let len = buf.readUint64(offset).toNumber();
    offset += 8;
    let s = buf.buffer.slice(offset, offset + len);
    batch.push(s);
    offset += len;
  }
  return batch;
}
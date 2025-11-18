import ByteBuffer, {
  LITTLE_ENDIAN
} from "bytebuffer";
import {
  header_t,
  header_t2buffer,
  buffer2header_t,
  block_info_t2buffer,
  buffer2block_info_t,
  ntpackage2batch,
  toNtInput,
  fromNtInput,
  batch2ntpackage
} from "./header_util.js"
import keccak256 from "keccak256";
import YPCCryptoFun from "./ypccrypto.js";
import YPCNtObjectFun from "./ypcntobject.js";
import BlockFileFun from "./blockfile.js";
var log = require("loglevel").getLogger("meta-encryptor/dataprovider");
const YPCCrypto = YPCCryptoFun();
const YPCNtObject = YPCNtObjectFun();

import {BlockNumLimit, MaxItemSize,
  HeaderSize, MagicNum,
  CurrentBlockFileVersion, BlockInfoSize} from "./limits.js";

const BlockFile = BlockFileFun(
  MagicNum,
  BlockNumLimit,
  256
);
const DataProvider = function(_key) {
  if (new.target === undefined) {
    throw new Error('DataProvider(_filename, _key) must be called with the new keyword.');
  }
  this.header = new header_t(0, 0, 0, 0);
  this.header.version_number = 2;
  this.block_meta_info = [];
  this.sealed_data = [];
  this.data_lines = [];
  this.counter = 0;

  this.key_pair = _key;
  this.data_hash = keccak256(Buffer.from("Fidelius", "utf-8"));
  this.all_line_num = 0,
    this.now_line_num = 0;
  this.sealBatch = [];
  this.sealBatchSize = 0;
}

DataProvider.prototype.write_batch = function(batch, public_key, writable_stream) {
  let pkg_bytes = batch2ntpackage(batch);
  // Ensure Node Buffer
  if(!Buffer.isBuffer(pkg_bytes)){
    pkg_bytes = Buffer.from(pkg_bytes);
  }
  const ots = YPCCrypto.generatePrivateKey();
  let s = YPCCrypto._encryptMessage(
    Buffer.from(public_key, "hex"),
    ots,
    pkg_bytes,
    0x2
  );
  let all = BlockFile.append_item(s, this.header, this.block_meta_info);
  this.header = all[0];
  this.block_meta_info = all[1];
  let data = new ByteBuffer(8 + s.length, LITTLE_ENDIAN);
  data.writeUint64(s.length, 0);
  data.append(s, 8);
  if (writable_stream !== undefined && writable_stream !== null) {
    const out = data.toBuffer();
    writable_stream.write(Buffer.isBuffer(out) ? out : Buffer.from(out));
  }
}

DataProvider.prototype.sealData = function(input,
  writable_stream = null,
  is_end = false) {
  let ntInput = null;
  input && (ntInput = toNtInput(input));
  if(ntInput){
    const bufNt = Buffer.isBuffer(ntInput) ? ntInput : Buffer.from(ntInput);
    this.sealBatch.push(bufNt);
    this.sealBatchSize += bufNt.length;
  }

  if (this.sealBatchSize >= MaxItemSize || (is_end && this.sealBatchSize > 0)) {
    this.write_batch(this.sealBatch, this.key_pair["public_key"], writable_stream);
    this.sealBatch = [];
    this.sealBatchSize = 0;
  }

  if (ntInput) {
    const rawNt = Buffer.isBuffer(ntInput) ? ntInput : Buffer.from(ntInput);
    let k = Buffer.concat([Buffer.from(this.data_hash), rawNt]);
    this.data_hash = keccak256(k);
  }

  if (!is_end) return null;

  const headerAndMeta = this.setHeaderAndMeta();
  if (writable_stream !== undefined &&
    writable_stream !== null) {
    let ret = writable_stream.write(headerAndMeta.blockInfo);
    ret = writable_stream.write(headerAndMeta.headerInfo);
  }
  return headerAndMeta.meta;
};

DataProvider.prototype.setHeaderAndMeta = function() {
  //let block_start_offset = 32 + 32 * BlockNumLimit;
  let block_start_offset = BlockInfoSize * this.header.block_number;
  let fileMeta = new ByteBuffer(block_start_offset, LITTLE_ENDIAN);
  let offset = 0;
  //set header
  this.header.data_hash = Buffer.from(this.data_hash);
  let buf_header = header_t2buffer(this.header);
  //fileMeta.append(buf_header, offset);
  //offset += 32;
  //set block meta
  for (let i = 0; i < this.header.block_number; i++) {
    let bi = this.block_meta_info[i];
    let buf_bi = block_info_t2buffer(bi);
    fileMeta.append(buf_bi, offset);
    offset += BlockInfoSize;
  }
  let b_skey = Buffer.from(this.key_pair["private_key"], "hex");
  let hash_sig = YPCCrypto.signMessage(b_skey, Buffer.from(this.data_hash));
  let meta = {
    data_hash: Buffer.from(this.data_hash).toString("hex"),
    shu_public_key: this.key_pair["public_key"],
    hash_sig: Buffer.from(hash_sig).toString("hex"),
  };
  buf_header.reset();
  fileMeta.reset();
  const headerInfo = buf_header.toBuffer();
  const blockInfo = fileMeta.toBuffer();
  return {
    headerInfo: Buffer.isBuffer(headerInfo) ? headerInfo : Buffer.from(headerInfo),
    blockInfo: Buffer.isBuffer(blockInfo) ? blockInfo : Buffer.from(blockInfo),
    meta,
  };
};

const headerAndBlockBufferFromBuffer = function(buf) {
  if (buf.length <= HeaderSize) {
    return null;
  }
  const buffer = buf.subarray(buf.length - HeaderSize);
  const header = buffer2header_t(ByteBuffer.wrap(buffer, LITTLE_ENDIAN));
  if (header.version_number != CurrentBlockFileVersion) {
    throw new Error("only support version ", CurrentBlockFileVersion, ", yet got ", header.version_number);
  }

  if (buf.length <= HeaderSize + BlockInfoSize * header.block_number) {
    return null;
  }

  const blkBuffer = buf.subarray(buf.length - HeaderSize - BlockInfoSize * header.block_number, buf.length - HeaderSize);

  return {
    header: buffer,
    block: blkBuffer
  }
}


export default {
  DataProvider,
  headerAndBlockBufferFromBuffer
};

import {
  header_t,
  block_info_t,
  header_t2buffer,
  buffer2header_t,
  block_info_t2buffer,
  buffer2block_info_t,
  ntpackage2batch,
  toNtInput,
  fromNtInput,
  batch2ntpackage
} from "../common/header_util.js"
import { createRollingHasher, resolveKeccak256 } from './keccak256.js';
import { MetaEncryptorError } from '../common/errors.js';
import YPCCryptoFun from "./ypccrypto.js";
import YPCNtObjectFun from "../common/ypcntobject.js";
import BlockFileFun from "./blockfile.js";
const YPCCrypto = YPCCryptoFun();

import {BlockNumLimit, MaxItemSize,
  HeaderSize, MagicNum,
  CurrentBlockFileVersion, BlockInfoSize} from "../common/limits.js";

const ItemNumPerBlock = 256;
const BlockFile = BlockFileFun(
  MagicNum,
  BlockNumLimit,
  ItemNumPerBlock
);
/**
 * @param {any} _key
 * @param {{ hashProvider?: { keccak256: (data: Uint8Array) => Uint8Array } }} [options]
 *   省略 hashProvider 时用 Node 默认（原生优先，见 ./keccak256.js）
 */
const DataProvider = function(_key, options = {}) {
  if (new.target === undefined) {
    throw new MetaEncryptorError('ERR_MUST_USE_NEW', { detail: { name: 'DataProvider' } });
  }
  this.header = new header_t(0, 0, 0, 0);
  this.header.version_number = 2;
  this.block_meta_info = [];
  this.sealed_data = [];
  this.data_lines = [];
  this.counter = 0;

  this.key_pair = _key;
  // 滚动哈希：每个 item 都要过一遍 keccak（原生优先），是加密的主要成本
  this._hashFn = resolveKeccak256(options.hashProvider);
  this._hasher = createRollingHasher(this._hashFn);
  this.data_hash = this._hasher.value;
  this.all_line_num = 0,
    this.now_line_num = 0;
  this.sealBatch = [];
  this.sealBatchSize = 0;
}

/**
 * 同一个文件的所有 item 共用一个封装会话（一次 ECDH + 顺序 IV），见 YPCCrypto.createSessionEncryptor。
 * write_batch 允许传入不同公钥，换公钥时重建会话。
 */
DataProvider.prototype._itemEncryptor = function(public_key) {
  if (!this._itemSession || this._itemSession.publicKeyHex !== public_key) {
    this._itemSession = {
      publicKeyHex: public_key,
      encryptor: YPCCrypto.createSessionEncryptor(Buffer.from(public_key, "hex"), 0x2),
    };
  }
  return this._itemSession.encryptor;
};

DataProvider.prototype.write_batch = function(batch, public_key, writable_stream) {
  let pkg_bytes = batch2ntpackage(batch);
  // Ensure Node Buffer
  if(!Buffer.isBuffer(pkg_bytes)){
    pkg_bytes = Buffer.from(pkg_bytes);
  }
  let s = this._itemEncryptor(public_key).encrypt(pkg_bytes);
  let all = BlockFile.append_item(s, this.header, this.block_meta_info);
  this.header = all[0];
  this.block_meta_info = all[1];
  const outBuf = Buffer.alloc(8 + s.length);
  outBuf.writeBigUInt64LE(BigInt(s.length), 0);
  if (Buffer.isBuffer(s)) {
    s.copy(outBuf, 8);
  } else {
    Buffer.from(s).copy(outBuf, 8);
  }
  if (writable_stream !== undefined && writable_stream !== null) {
    writable_stream.write(outBuf);
  }
}

/** 把未满 MaxItemSize 的待封装批次立即封成一个 item（不写文件尾） */
DataProvider.prototype.flushBatch = function(writable_stream = null) {
  if (this.sealBatchSize === 0) return;
  this.write_batch(this.sealBatch, this.key_pair["public_key"], writable_stream);
  this.sealBatch = [];
  this.sealBatchSize = 0;
};

/** 各 block 起始文件偏移（uint64 LE 依次排列），供加密断点持久化 */
DataProvider.prototype.blockStarts = function() {
  const n = this.block_meta_info.length;
  const buf = Buffer.alloc(8 * n);
  for (let i = 0; i < n; i++) {
    buf.writeBigUInt64LE(BigInt(this.block_meta_info[i].start_file_pos), 8 * i);
  }
  return buf;
};

/**
 * 从加密断点恢复：已封装 itemCount 个 item、共 sealedBytes 字节，滚动哈希为 dataHash。
 * block 信息由各 block 起始偏移推出（每 block 固定 ItemNumPerBlock 个 item）。
 * 恢复后的 item 用新的会话密钥加密（不持久化任何密钥材料）。
 */
DataProvider.prototype.restoreSealState = function({ itemCount, sealedBytes, blockStarts, dataHash }) {
  const blockNumber = Math.ceil(itemCount / ItemNumPerBlock);
  if (!Buffer.isBuffer(dataHash) || dataHash.length !== 32) {
    throw new MetaEncryptorError('ERR_SEAL_CONTEXT_INVALID', { detail: { reason: 'dataHash' } });
  }
  if (!Buffer.isBuffer(blockStarts) || blockStarts.length !== 8 * blockNumber) {
    throw new MetaEncryptorError('ERR_SEAL_CONTEXT_INVALID', { detail: { reason: 'blockStarts' } });
  }
  const blocks = [];
  for (let i = 0; i < blockNumber; i++) {
    const last = i === blockNumber - 1;
    blocks.push(new block_info_t(
      i * ItemNumPerBlock,
      last ? itemCount : (i + 1) * ItemNumPerBlock,
      Number(blockStarts.readBigUInt64LE(8 * i)),
      last ? sealedBytes : Number(blockStarts.readBigUInt64LE(8 * (i + 1)))
    ));
  }
  this.header = new header_t(MagicNum, CurrentBlockFileVersion, blockNumber, itemCount);
  this.block_meta_info = blocks;
  this._hasher = createRollingHasher(this._hashFn, Buffer.from(dataHash));
  this.data_hash = this._hasher.value;
  this.sealBatch = [];
  this.sealBatchSize = 0;
};

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
    this.data_hash = this._hasher.update(rawNt);
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
  const fileMetaBuf = Buffer.alloc(block_start_offset);
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
    if (!Buffer.isBuffer(buf_bi)) buf_bi = Buffer.from(buf_bi);
    buf_bi.copy(fileMetaBuf, offset);
    offset += BlockInfoSize;
  }
  let b_skey = Buffer.from(this.key_pair["private_key"], "hex");
  let hash_sig = YPCCrypto.signMessage(b_skey, Buffer.from(this.data_hash));
  let meta = {
    data_hash: Buffer.from(this.data_hash).toString("hex"),
    shu_public_key: this.key_pair["public_key"],
    hash_sig: Buffer.from(hash_sig).toString("hex"),
  };
  
  const headerInfo = Buffer.isBuffer(buf_header) ? buf_header : Buffer.from(buf_header);
  const blockInfo = Buffer.isBuffer(fileMetaBuf) ? fileMetaBuf : Buffer.from(fileMetaBuf);
  
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
  const header = buffer2header_t(buffer);
  if (header.version_number != CurrentBlockFileVersion) {
    throw new MetaEncryptorError('ERR_VERSION_MISMATCH', { detail: { expected: CurrentBlockFileVersion, actual: header.version_number } });
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

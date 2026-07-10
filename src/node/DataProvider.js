import {
  header_t,
  header_t2buffer,
  buffer2header_t,
  block_info_t2buffer,
  buffer2block_info_t,
  toNtInput,
  batch2ntpackage,
} from "../common/header_util.js"
import { hexToBytes, toUint8Array } from "../common/ypccrypto.common.js";
import { validateSealedLayout } from "../common/unsealer_core.js";
import { keccak_256 as keccak256} from '@noble/hashes/sha3';
import { MetaEncryptorError } from '../common/errors.js';
import YPCCryptoFun from "./ypccrypto.js";
import BlockFileFun from "./blockfile.js";
const YPCCrypto = YPCCryptoFun();

import {BlockNumLimit, MaxItemSize, MaxItemNumber, MaxPlaintextChunkSize,
  CryptoEnvelopeSize, NtPackageHeaderSize, NtPackageItemHeaderSize,
  HeaderSize, MagicNum,
  CurrentBlockFileVersion, BlockInfoSize} from "../common/limits.js";

const BlockFile = BlockFileFun(
  MagicNum,
  BlockNumLimit,
  256
);
const DataProvider = function(_key) {
  if (new.target === undefined) {
    throw new MetaEncryptorError('ERR_MUST_USE_NEW', { detail: { name: 'DataProvider' } });
  }
  this.header = new header_t(0, 0, 0, 0);
  // magic must be set here, not only in BlockFile.append_item — otherwise a
  // zero-item seal (empty input) writes a header with a zero magic number,
  // producing a sealed file that can never be validated/unsealed.
  this.header.magic_number = MagicNum;
  this.header.version_number = 2;
  this.block_meta_info = [];
  this.sealed_data = [];
  this.data_lines = [];
  this.counter = 0;

  this.key_pair = _key;
  this.data_hash = Buffer.from(keccak256(Buffer.from("Fidelius", "utf-8")));
  this.all_line_num = 0,
    this.now_line_num = 0;
  this.sealBatch = [];
  this.sealBatchSize = NtPackageHeaderSize;
}

DataProvider.prototype.write_batch = function(batch, public_key, writable_stream) {
  if (!Array.isArray(batch) || batch.length === 0) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'emptyBatch' } });
  }
  if (this.header.item_number >= MaxItemNumber) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'itemNumberLimit' } });
  }
  let pkg_bytes = batch2ntpackage(batch);
  // Ensure Node Buffer
  if(!Buffer.isBuffer(pkg_bytes)){
    pkg_bytes = Buffer.from(pkg_bytes);
  }
  const ots = YPCCrypto.generatePrivateKey();
  let s = YPCCrypto._encryptMessage(
    Buffer.from(hexToBytes(public_key)),
    ots,
    pkg_bytes,
    0x2
  );
  if (s.length > MaxItemSize) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'itemSize', itemSize: s.length, maximum: MaxItemSize }
    });
  }
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

DataProvider.prototype.sealData = function(input,
  writable_stream = null,
  is_end = false) {
  if (input !== null && input !== undefined) {
    let inputBytes;
    if (typeof input === 'string') {
      inputBytes = Buffer.from(input, 'utf8');
    } else {
      const bytes = toUint8Array(input);
      inputBytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    for (let offset = 0; offset < inputBytes.length; offset += MaxPlaintextChunkSize) {
      const plain = inputBytes.subarray(offset, Math.min(offset + MaxPlaintextChunkSize, inputBytes.length));
      const rawNt = Buffer.from(toNtInput(plain));
      const projectedPackageSize = this.sealBatchSize + NtPackageItemHeaderSize + rawNt.length;

      if (this.sealBatch.length > 0 && projectedPackageSize + CryptoEnvelopeSize > MaxItemSize) {
        this.write_batch(this.sealBatch, this.key_pair["public_key"], writable_stream);
        this.sealBatch = [];
        this.sealBatchSize = NtPackageHeaderSize;
      }

      const singleItemSize = this.sealBatchSize + NtPackageItemHeaderSize + rawNt.length + CryptoEnvelopeSize;
      if (singleItemSize > MaxItemSize) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
          detail: { field: 'itemSize', itemSize: singleItemSize, maximum: MaxItemSize }
        });
      }

      this.sealBatch.push(rawNt);
      this.sealBatchSize += NtPackageItemHeaderSize + rawNt.length;
      this.data_hash = Buffer.from(keccak256(Buffer.concat([this.data_hash, rawNt])));
    }
  }

  if (is_end && this.sealBatch.length > 0) {
    this.write_batch(this.sealBatch, this.key_pair["public_key"], writable_stream);
    this.sealBatch = [];
    this.sealBatchSize = NtPackageHeaderSize;
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
  let b_skey = Buffer.from(hexToBytes(this.key_pair["private_key"]));
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
  if (buf.length < HeaderSize) {
    return null;
  }
  const buffer = buf.subarray(buf.length - HeaderSize);
  const header = buffer2header_t(buffer);
  if (header.version_number != CurrentBlockFileVersion) {
    throw new MetaEncryptorError('ERR_VERSION_MISMATCH', { detail: { expected: CurrentBlockFileVersion, actual: header.version_number } });
  }

  if (buf.length < HeaderSize + BlockInfoSize * header.block_number) {
    return null;
  }

  const blkBuffer = buf.subarray(buf.length - HeaderSize - BlockInfoSize * header.block_number, buf.length - HeaderSize);
  const contentSize = buf.length - HeaderSize - blkBuffer.length;
  validateSealedLayout(buffer, blkBuffer, contentSize, buf.length);

  return {
    header: buffer,
    block: blkBuffer
  }
}


export default {
  DataProvider,
  headerAndBlockBufferFromBuffer
};

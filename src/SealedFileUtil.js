import { header_t, block_info_t, buffer2header_t } from './header_util.js';
import ByteBuffer, { LITTLE_ENDIAN } from 'bytebuffer';
import YPCCryptoFun from './ypccrypto.js';
const YPCCrypto = YPCCryptoFun();
import fs from 'fs';
import keccak256 from 'keccak256';
import { BlockNumLimit, MaxItemSize, HeaderSize, MagicNum } from './limits.js';
const anyEnclave = Buffer.from(
  'bd0c3cce561fac62b90ddd7bfcfe014702aa4327bc2b0b69ef79a7d2a0350f11',
  'hex'
);

const getFileHeader = function (filePath) {
  const srcStat = fs.statSync(filePath);
  if (srcStat.size <= HeaderSize) {
    return null;
  }

  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(HeaderSize);
  let readLen = fs.readSync(
    fd,
    buffer,
    0,
    HeaderSize,
    srcStat.size - HeaderSize
  );
  if (readLen != HeaderSize) {
    fs.closeSync(fd);
    return null;
  }
  const header = buffer2header_t(ByteBuffer.wrap(buffer, LITTLE_ENDIAN));
  return header;
};

export const isSealedFile = function (filePath) {
  const header = getFileHeader(filePath);
  if (header == null) {
    return false;
  }

  if (header.magic_number.equals(MagicNum)) {
    return true;
  } else {
    return false;
  }
};
export const sealedFileVersion = function (filePath) {
  const header = getFileHeader(filePath);
  if (header == null) {
    return 0;
  }
  return header.version_number;
};

export const dataHashOfSealedFile = function (filePath) {
  const header = getFileHeader(filePath);
  if (header == null) {
    return null;
  }
  return header.data_hash;
};

export const signedDataHash = function (keyPair, dataHash) {
  let b_skey = Buffer.from(keyPair['private_key'], 'hex');
  let hash_sig = YPCCrypto.signMessage(b_skey, dataHash);
  return hash_sig;
};

export const forwardSkey = function (
  keyPair,
  dianPKey,
  enclaveHash = anyEnclave
) {
  let b_skey = Buffer.from(keyPair['private_key'], 'hex');
  let forwardSkey = YPCCrypto.generateForwardSecretKey(dianPKey, b_skey);
  let forwardSig = YPCCrypto.generateSignature(b_skey, dianPKey, enclaveHash);
  return { encrypted_skey: forwardSkey, forward_sig: forwardSig };
};

export function calculateSealedHash(filePath) {
  // 读取文件尾部的header
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  const headerSize = 64;
  const header = ByteBuffer.wrap(
    fs.readFileSync(filePath, {
      start: fileSize - headerSize,
      end: fileSize,
    }),
    ByteBuffer.LITTLE_ENDIAN
  );

  // 获取item数量
  const itemNumber = header.readUint64(24).toNumber();

  // 计算hash
  let resultHash = keccak256(Buffer.from('Fidelius', 'utf-8'));
  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    for (let i = 0; i < itemNumber; i++) {
      // 读取长度
      const lenBuf = Buffer.alloc(8);
      fs.readSync(fd, lenBuf, 0, 8, offset);
      const len = ByteBuffer.wrap(lenBuf, ByteBuffer.LITTLE_ENDIAN)
        .readUint64(0)
        .toNumber();
      offset += 8;

      // 读取数据并更新hash
      const dataBuf = Buffer.alloc(len);
      fs.readSync(fd, dataBuf, 0, len, offset);
      resultHash = keccak256(Buffer.concat([resultHash, dataBuf]));
      offset += len;
    }
    return resultHash.toString('hex');
  } finally {
    fs.closeSync(fd);
  }
}

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
  console.log('开始处理文件:', filePath);

  // 读取文件末尾的header
  function readLast64BytesSync(filePath) {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const bytesToRead = fileSize < 64 ? fileSize : 64;
    const startPosition = fileSize - bytesToRead;

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, startPosition);
      const bb = ByteBuffer.wrap(buffer, ByteBuffer.LITTLE_ENDIAN);
      return bb;
    } finally {
      fs.closeSync(fd);
    }
  }

  // 解析header
  let header = readLast64BytesSync(filePath);
  let magic_number = Buffer.from(header.buffer.subarray(0, 8));
  let version_number = header.readUint64(8).toNumber();
  let block_number = header.readUint64(16).toNumber();
  let item_number = header.readUint64(24).toNumber();

  console.log('文件包含items数量:', item_number);

  // 计算hash
  const fd = fs.openSync(filePath, 'r');
  let result_hash = keccak256(Buffer.from('Fidelius', 'utf-8'));
  let offset = 0;

  try {
    for (let i = 0; i < item_number; i++) {
      if (i % 1000 === 0) {
        console.log(`处理进度: ${i}/${item_number}`);
      }

      // 读取长度
      let bytesToRead = 8;
      let buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, offset);
      let b = ByteBuffer.wrap(buf, ByteBuffer.LITTLE_ENDIAN);
      let len = b.readUint64(0).toNumber();
      offset += 8;

      // 读取数据
      bytesToRead = len;
      buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, offset);
      let k = Buffer.concat([Buffer.from(result_hash), buf]);
      result_hash = keccak256(k);
      offset += len;
    }

    console.log('处理完成');
    return result_hash.toString('hex');
  } finally {
    fs.closeSync(fd);
  }
}

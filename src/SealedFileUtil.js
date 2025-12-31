import { header_t, block_info_t, buffer2header_t } from './header_util.js';
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
  const header = buffer2header_t(buffer);
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

  // 读取文件大小
  const fileStats = fs.statSync(filePath);
  const fileSize = fileStats.size;
  console.log('文件大小:', fileSize, 'bytes');

  // 常量定义
  const BLOCK_SIZE = 64 * 1024; // 64KB
  const HEADER_SIZE = 64; // 末尾header大小
  const ITEM_HEADER_SIZE = 8; // 每个item的长度字段大小

  // 估算items数量
  const dataSize = fileSize - HEADER_SIZE;
  const estimatedBlocks = Math.ceil(dataSize / BLOCK_SIZE);

  function readLast64BytesSync(filePath) {
    const fileSize = fs.statSync(filePath).size;
    const bytesToRead = HEADER_SIZE;
    const startPosition = fileSize - bytesToRead;

    if (startPosition < 0) {
      throw new Error('文件大小小于header大小');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, startPosition);

      if (bytesRead !== bytesToRead) {
        throw new Error(
          `Header读取不完整: 期望${HEADER_SIZE}字节，实际读取${bytesRead}字节`
        );
      }

      console.log('Header raw bytes:', buffer.toString('hex'));

      const bb = buffer;
      return bb;
    } finally {
      fs.closeSync(fd);
    }
  }

  // 解析header
  let header = readLast64BytesSync(filePath);
  let item_number = header.readUint64(24).toNumber();

  // 验证items数量的合理性
  if (item_number > estimatedBlocks * 2) {
    // 允许2倍的误差
    throw new Error(
      `Items数量异常: ${item_number}，基于文件大小和块大小预期最大数量应该小于${estimatedBlocks}`
    );
  }

  // 计算hash
  const fd = fs.openSync(filePath, 'r');
  let result_hash = keccak256(Buffer.from('Fidelius', 'utf-8'));
  let offset = 0;
  let currentBlock = 0;

  try {
    for (let i = 0; i < item_number; i++) {
      if (i % 1000 === 0) {
        console.log(
          `处理进度: ${i}/${item_number}，当前block: ${Math.floor(
            offset / BLOCK_SIZE
          )}`
        );
      }

      // 验证偏移量不超过文件大小
      if (offset >= fileSize - HEADER_SIZE) {
        throw new Error(
          `偏移量${offset}超过文件大小限制${fileSize - HEADER_SIZE}`
        );
      }

      // 读取长度
      let bytesToRead = ITEM_HEADER_SIZE;
      let buf = Buffer.alloc(bytesToRead);
      const lengthBytesRead = fs.readSync(fd, buf, 0, bytesToRead, offset);

      if (lengthBytesRead !== bytesToRead) {
        throw new Error(
          `长度读取不完整: 位置${offset}，期望${bytesToRead}字节，实际读取${lengthBytesRead}字节`
        );
      }

      let b = buf;
      let len = b.readUint64(0).toNumber();

      // 验证单个item的长度合理性

      offset += ITEM_HEADER_SIZE;

      // 检查是否跨越了块边界
      const currentBlockNumber = Math.floor(offset / BLOCK_SIZE);
      if (currentBlockNumber > currentBlock) {
        currentBlock = currentBlockNumber;
      }

      // 读取数据
      bytesToRead = len;
      buf = Buffer.alloc(bytesToRead);
      const dataBytesRead = fs.readSync(fd, buf, 0, bytesToRead, offset);

      if (dataBytesRead !== bytesToRead) {
        throw new Error(
          `数据读取不完整: 位置${offset}，期望${bytesToRead}字节，实际读取${dataBytesRead}字节`
        );
      }

      let k = Buffer.concat([Buffer.from(result_hash), buf]);
      result_hash = keccak256(k);
      offset += len;
    }

    return result_hash.toString('hex');
  } finally {
    fs.closeSync(fd);
  }
}

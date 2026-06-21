import { header_t, block_info_t, buffer2header_t } from '../common/header_util.js';
import YPCCryptoFun from './ypccrypto.js';
const YPCCrypto = YPCCryptoFun();
import fs from 'fs';
import { keccak_256 as keccak256} from '@noble/hashes/sha3';
import { MetaEncryptorError } from '../common/errors.js';
import { BlockNumLimit, MaxItemSize, HeaderSize, MagicNum } from '../common/limits.js';
import log from 'loglevel';

const logger = log.getLogger('meta-encryptor/SealedFileUtil');
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
  logger.debug('Processing file:', filePath);

  const fileStats = fs.statSync(filePath);
  const fileSize = fileStats.size;
  logger.debug('File size:', fileSize, 'bytes');

  const BLOCK_SIZE = 64 * 1024;
  const HEADER_SIZE = 64;
  const ITEM_HEADER_SIZE = 8;

  const dataSize = fileSize - HEADER_SIZE;
  const estimatedBlocks = Math.ceil(dataSize / BLOCK_SIZE);

  function readLast64BytesSync(filePath) {
    const fileSize = fs.statSync(filePath).size;
    const bytesToRead = HEADER_SIZE;
    const startPosition = fileSize - bytesToRead;

    if (startPosition < 0) {
      throw new MetaEncryptorError('ERR_FILE_TOO_SMALL');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, startPosition);

      if (bytesRead !== bytesToRead) {
        throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE', { detail: { expected: HEADER_SIZE, actual: bytesRead } });
      }

      logger.debug('Header raw bytes:', buffer.toString('hex'));

      const bb = buffer;
      return bb;
    } finally {
      fs.closeSync(fd);
    }
  }

  let header = readLast64BytesSync(filePath);
  let item_number = header.readUint64(24).toNumber();

  if (item_number > estimatedBlocks * 2) {
  }

  const fd = fs.openSync(filePath, 'r');
  let result_hash = Buffer.from(keccak256(Buffer.from('Fidelius', 'utf-8')));
  let offset = 0;
  let currentBlock = 0;

  try {
    for (let i = 0; i < item_number; i++) {
      if (i % 1000 === 0) {
        logger.debug(`Progress: ${i}/${item_number}, block: ${Math.floor(offset / BLOCK_SIZE)}`);
      }

      if (offset >= fileSize - HEADER_SIZE) {
        throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', { detail: { offset, limit: fileSize - HEADER_SIZE } });
      }

      let bytesToRead = ITEM_HEADER_SIZE;
      let buf = Buffer.alloc(bytesToRead);
      const lengthBytesRead = fs.readSync(fd, buf, 0, bytesToRead, offset);

      if (lengthBytesRead !== bytesToRead) {
        throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE', { detail: { offset, expected: bytesToRead, actual: lengthBytesRead } });
      }

      let b = buf;
      let len = b.readUint64(0).toNumber();

      offset += ITEM_HEADER_SIZE;

      const currentBlockNumber = Math.floor(offset / BLOCK_SIZE);
      if (currentBlockNumber > currentBlock) {
        currentBlock = currentBlockNumber;
      }

      bytesToRead = len;
      buf = Buffer.alloc(bytesToRead);
      const dataBytesRead = fs.readSync(fd, buf, 0, bytesToRead, offset);

      if (dataBytesRead !== bytesToRead) {
        throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE', { detail: { offset, expected: bytesToRead, actual: dataBytesRead } });
      }

      let k = Buffer.concat([Buffer.from(result_hash), buf]);
      result_hash = Buffer.from(keccak256(k));
      offset += len;
    }

    return result_hash.toString('hex');
  } finally {
    fs.closeSync(fd);
  }
}

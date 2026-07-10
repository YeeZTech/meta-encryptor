import { buffer2header_t } from '../common/header_util.js';
import YPCCryptoFun from './ypccrypto.js';
const YPCCrypto = YPCCryptoFun();
import fs from 'fs';
import { keccak_256 as keccak256} from '@noble/hashes/sha3';
import { MetaEncryptorError } from '../common/errors.js';
import {
  BlockNumLimit,
  ItemsPerBlockLimit,
  MaxItemNumber,
  MaxSealedItemSize,
  HeaderSize,
  BlockInfoSize,
  MagicNum,
  CurrentBlockFileVersion
} from '../common/limits.js';
import log from 'loglevel';

const logger = log.getLogger('meta-encryptor/SealedFileUtil');
const anyEnclave = Buffer.from(
  'bd0c3cce561fac62b90ddd7bfcfe014702aa4327bc2b0b69ef79a7d2a0350f11',
  'hex'
);

const getFileHeader = function (filePath) {
  const srcStat = fs.statSync(filePath);
  if (srcStat.size < HeaderSize) {
    return null;
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(HeaderSize);
    const readLen = fs.readSync(fd, buffer, 0, HeaderSize, srcStat.size - HeaderSize);
    if (readLen !== HeaderSize) return null;
    try {
      return buffer2header_t(buffer);
    } catch (error) {
      if (error instanceof MetaEncryptorError) return null;
      throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
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
  if (fileSize < HeaderSize) {
    throw new MetaEncryptorError('ERR_FILE_TOO_SMALL');
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const headerBuffer = Buffer.allocUnsafe(HeaderSize);
    if (fs.readSync(fd, headerBuffer, 0, HeaderSize, fileSize - HeaderSize) !== HeaderSize) {
      throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE');
    }
    const header = buffer2header_t(headerBuffer);
    if (!header.magic_number.equals(MagicNum) || header.version_number !== CurrentBlockFileVersion) {
      throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'header' } });
    }
    for (const [field, value, maximum] of [
      ['blockNumber', header.block_number, BlockNumLimit],
      ['itemNumber', header.item_number, MaxItemNumber]
    ]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field, value } });
      }
    }
    const expectedBlocks = header.item_number === 0
      ? 0
      : Math.ceil(header.item_number / ItemsPerBlockLimit);
    if (header.block_number !== expectedBlocks) {
      throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'blockNumber' } });
    }
    const contentSize = fileSize - HeaderSize - header.block_number * BlockInfoSize;
    if (!Number.isSafeInteger(contentSize) || contentSize < 0) {
      throw new MetaEncryptorError('ERR_INVALID_FILE_SIZE');
    }

    let resultHash = Buffer.from(keccak256(Buffer.from('Fidelius', 'utf8')));
    let offset = 0;
    const lengthBuffer = Buffer.allocUnsafe(8);
    for (let i = 0; i < header.item_number; i += 1) {
      if (offset + 8 > contentSize || fs.readSync(fd, lengthBuffer, 0, 8, offset) !== 8) {
        throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', { detail: { itemIndex: i, offset } });
      }
      const lengthBig = lengthBuffer.readBigUInt64LE(0);
      if (lengthBig === 0n || lengthBig > BigInt(MaxSealedItemSize)) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
          detail: { field: 'itemSize', itemIndex: i, value: lengthBig.toString() }
        });
      }
      const length = Number(lengthBig);
      offset += 8;
      if (offset + length > contentSize) {
        throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', { detail: { itemIndex: i, offset } });
      }
      const cipher = Buffer.allocUnsafe(length);
      if (fs.readSync(fd, cipher, 0, length, offset) !== length) {
        throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', { detail: { itemIndex: i, offset } });
      }
      resultHash = Buffer.from(keccak256(Buffer.concat([resultHash, cipher])));
      offset += length;
    }
    if (offset !== contentSize) {
      throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
        detail: { field: 'trailingContent', trailingBytes: contentSize - offset }
      });
    }
    return resultHash.toString('hex');
  } finally {
    fs.closeSync(fd);
  }
}

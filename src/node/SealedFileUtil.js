import { buffer2header_t } from '../common/header_util.js';
import YPCCryptoFun from './ypccrypto.js';
const YPCCrypto = YPCCryptoFun();
import fs from 'fs';
import { HeaderSize, MagicNum } from '../common/limits.js';

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
export { calculateSealedHash, calculateSealedHashAsync } from './SealedHash.js';

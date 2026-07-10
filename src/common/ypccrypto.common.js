import { ECB } from 'aes-js';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';
import secp256k1 from 'secp256k1';
import { Buffer } from 'buffer';
import { MetaEncryptorError } from './errors.js';

import { sha256 } from '@noble/hashes/sha256';

function hexToBytes(hex){
  if (typeof hex !== 'string') {
    throw new MetaEncryptorError('ERR_INVALID_HEX', { detail: { type: typeof hex } });
  }
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new MetaEncryptorError('ERR_INVALID_HEX', { detail: { length: clean.length } });
  }
  const arr = new Uint8Array(clean.length / 2);
  for(let i=0;i<arr.length;i++){ arr[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16); }
  return arr;
}

function hashfn(x, y) {
  const version = new Uint8Array(33);

  const hasher = sha256.create();

  version[0] = (y[31] & 1) === 0 ? 0x02 : 0x03;
  version.set(x, 1);
  hasher.update(version);
  return hasher.digest();
}

function aesCmac(key, message){
  const aes = new ECB(key);
  const blockSize = 16;
  function leftShift(buf){
    const out = new Uint8Array(buf.length);
    let carry = 0;
    for(let i=buf.length-1;i>=0;i--){
      const val = buf[i];
      out[i] = ((val<<1)&0xFF) | carry;
      carry = (val & 0x80)?1:0;
    }
    return out;
  }
  const constRb = 0x87;
  function xor16(a,b){const o=new Uint8Array(16);for(let i=0;i<16;i++)o[i]=a[i]^b[i];return o;}
  let zeros = new Uint8Array(16);
  let L = aes.encrypt(zeros);
  L = new Uint8Array(L);
  let K1 = leftShift(L);
  if((L[0] & 0x80)!==0){K1[15] ^= constRb;}
  let K2 = leftShift(K1);
  if((K1[0] & 0x80)!==0){K2[15] ^= constRb;}
  const m = new Uint8Array(message);
  const n = Math.ceil(m.length / blockSize);
  let flagComplete = m.length>0 && (m.length % blockSize === 0);
  let lastBlock;
  if(n===0){
    flagComplete = false;
    lastBlock = xor16(xor16(zeros,K2),new Uint8Array([0x80,...new Array(15).fill(0)]));
  }else{
    const startLast = (n-1)*blockSize;
    let lb = m.slice(startLast, startLast+blockSize);
    if(flagComplete){
      lastBlock = xor16(lb,K1);
    }else{
      let pad = new Uint8Array(blockSize);
      pad.set(lb); pad[lb.length]=0x80;
      lastBlock = xor16(pad,K2);
    }
  }
  let X = new Uint8Array(16);
  for(let i=0;i<n-1;i++){
    const block = m.slice(i*blockSize,(i+1)*blockSize);
    X = aes.encrypt(xor16(X, block));
    X = new Uint8Array(X);
  }
  let T = aes.encrypt(xor16(X,lastBlock));
  return new Uint8Array(T);
}

function gen_ecdh_key_from(skey, pkey) {
  const out = new Uint8Array(32);
  const ecdhPointX = secp256k1.ecdh(toUint8Array(pkey), toUint8Array(skey), { hashfn }, out);
  return ecdhPointX;
}

const aad = new TextEncoder().encode('tech.yeez.key.manager');
const cmac_key = hexToBytes('7965657a2e746563682e7374626f7800');
let derivation_buffer = new Uint8Array(aad.length + 4);
derivation_buffer[0] = 0x01;
derivation_buffer.set(aad, 1);
derivation_buffer[aad.length + 1] = 0;
derivation_buffer[aad.length + 2] = 0x80;
derivation_buffer[aad.length + 3] = 0x00;
derivation_buffer = Buffer.from(derivation_buffer);

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return hexToBytes(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  // Preserve the exact view for legacy wrappers such as { buffer: Buffer }.
  if (data && data.buffer !== undefined) {
    const wrapped = data.buffer;
    if (ArrayBuffer.isView(wrapped)) {
      const relativeOffset = data.byteOffset ?? 0;
      const byteLength = data.byteLength ?? (wrapped.byteLength - relativeOffset);
      if (!Number.isInteger(relativeOffset) || relativeOffset < 0 ||
          !Number.isInteger(byteLength) || byteLength < 0 ||
          relativeOffset + byteLength > wrapped.byteLength) {
        throw new MetaEncryptorError('ERR_INVALID_BINARY_INPUT');
      }
      return new Uint8Array(
        wrapped.buffer,
        wrapped.byteOffset + relativeOffset,
        byteLength
      );
    }
    if (wrapped instanceof ArrayBuffer) {
      const byteOffset = data.byteOffset ?? 0;
      const byteLength = data.byteLength ?? (wrapped.byteLength - byteOffset);
      if (!Number.isInteger(byteOffset) || byteOffset < 0 ||
          !Number.isInteger(byteLength) || byteLength < 0 ||
          byteOffset + byteLength > wrapped.byteLength) {
        throw new MetaEncryptorError('ERR_INVALID_BINARY_INPUT');
      }
      return new Uint8Array(wrapped, byteOffset, byteLength);
    }
  }
  try {
    return new Uint8Array(data);
  } catch (cause) {
    throw new MetaEncryptorError('ERR_INVALID_BINARY_INPUT', { cause });
  }
}

function toHex(bytes) {
  const arr = Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generatePublicKeyFromPrivateKey(skey){
  const skeyBytes = toUint8Array(skey);
  if (!secp256k1.privateKeyVerify(skeyBytes)) {
    throw new MetaEncryptorError('ERR_INVALID_PRIVATE_KEY');
  }
  const pkey = secp256k1.publicKeyCreate(skeyBytes, false).subarray(1);
  return Buffer.from(pkey);
}

function generateAESKeyFrom(pkey, skey){
  pkey = toUint8Array(pkey);
  skey = toUint8Array(skey);
  if (skey.length !== 32 || !secp256k1.privateKeyVerify(skey)) {
    throw new MetaEncryptorError('ERR_INVALID_PRIVATE_KEY');
  }
  if (pkey.length === 64) {
    const prefix = new Uint8Array([0x04]);
    pkey = new Uint8Array(pkey);
    pkey = Uint8Array.from([...prefix, ...pkey]);
  }
  if (!secp256k1.publicKeyVerify(pkey)) {
    throw new MetaEncryptorError('ERR_INVALID_PUBLIC_KEY');
  }
  const shared_key = gen_ecdh_key_from(skey, pkey);
  const key_derive_key = aesCmac(cmac_key, shared_key);
  const derived_key = aesCmac(key_derive_key, derivation_buffer);
  return derived_key;
}

const eth_hash_prefix = Buffer.concat([
  Buffer.from([0x19]),
  Buffer.from("Ethereum Signed Message:\n32"),
]);

function signMessage(skey, raw) {
  let raw_hash = Buffer.from(keccak256(toUint8Array(raw)));
  let msg = new Uint8Array(eth_hash_prefix.length + raw_hash.length)
  msg.set(eth_hash_prefix)
  msg.set(raw_hash, eth_hash_prefix.length)
  msg = Buffer.from(keccak256(toUint8Array(msg)))

  const msgBytes = toUint8Array(msg);
  const skeyBytes = toUint8Array(skey);
  if (skeyBytes.length !== 32 || !secp256k1.privateKeyVerify(skeyBytes)) {
    throw new MetaEncryptorError('ERR_INVALID_PRIVATE_KEY');
  }
  const rsig = secp256k1.ecdsaSign(msgBytes, skeyBytes);
  const sig = new Uint8Array(65);
  sig.set(rsig.signature);
  sig[64] = rsig.recid + 27;
  return Buffer.from(sig);
}

export {
  hexToBytes,
  hashfn,
  aesCmac,
  gen_ecdh_key_from,
  aad,
  cmac_key,
  derivation_buffer,
  toUint8Array,
  toHex,
  generatePublicKeyFromPrivateKey,
  generateAESKeyFrom,
  eth_hash_prefix,
  signMessage,
};

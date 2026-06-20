import { ECB } from 'aes-js';
import keccak256 from './keccak256.js';
import secp256k1 from 'secp256k1';
import { Buffer } from 'buffer';

import 'js-sha256/src/sha256.js';

let sha256Cached;
function sha256Api() {
  if (sha256Cached) return sha256Cached;
  const g = globalThis.sha256;
  if (g && typeof g.create === 'function') {
    sha256Cached = g;
    return sha256Cached;
  }
  const hint = g === undefined ? 'undefined' : typeof g;
  throw new Error(`sha256 is not a function (globalThis.sha256 is ${hint})`);
}

function hexToBytes(hex){
  const clean = hex.startsWith('0x')? hex.slice(2): hex;
  const arr = new Uint8Array(clean.length/2);
  for(let i=0;i<arr.length;i++){ arr[i] = parseInt(hex.substr(i*2,2),16); }
  return arr;
}

function hashfn(x, y) {
  const version = new Uint8Array(33);

  const sha = sha256Api().create();

  version[0] = (y[31] & 1) === 0 ? 0x02 : 0x03;
  version.set(x, 1);
  sha.update(version);
  return new Uint8Array(sha.array());
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
  if (typeof data === 'string') {
    if (data.startsWith('0x')) data = data.slice(2);
    const arr = new Uint8Array(data.length / 2);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = parseInt(data.substr(i * 2, 2), 16);
    }
    return arr;
  }
  if (data && data.buffer) {
    return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length);
  }
  return new Uint8Array(data);
}

function toHex(bytes) {
  const arr = Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generatePublicKeyFromPrivateKey(skey){
  const skeyBytes = toUint8Array(skey);
  if (!secp256k1.privateKeyVerify(skeyBytes)) {
    throw new Error('invalid private key');
  }
  const pkey = secp256k1.publicKeyCreate(skeyBytes, false).subarray(1);
  return Buffer.from(pkey);
}

function generateAESKeyFrom(pkey, skey){
  if (pkey.length === 64) {
    const prefix = new Uint8Array([0x04]);
    pkey = new Uint8Array(pkey);
    pkey = Uint8Array.from([...prefix, ...pkey]);
  }
  const shared_key = gen_ecdh_key_from(skey, pkey);
  const key_derive_key = aesCmac(cmac_key, shared_key);
  const derived_key = aesCmac(key_derive_key, derivation_buffer);
  return derived_key;
}

const eth_hash_prefix = Buffer.from("\\x19Ethereum Signed Message:\\n32");

function signMessage(skey, raw) {
  let raw_hash = keccak256(Buffer.from(raw));
  let msg = new Uint8Array(eth_hash_prefix.length + raw_hash.length)
  msg.set(eth_hash_prefix)
  msg.set(raw_hash, eth_hash_prefix.length)
  msg = keccak256(Buffer.from(msg))

  const msgBytes = toUint8Array(msg);
  const skeyBytes = toUint8Array(skey);
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

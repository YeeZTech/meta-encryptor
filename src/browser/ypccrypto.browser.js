// Browser implementation of ypccrypto decrypt logic using @noble/secp256k1 and WebCrypto
// Derivation mimics aes-cmac based scheme from node version using pure JS AES-CMAC.
import {getPublicKey, getSharedSecret} from '@noble/secp256k1';
// 直接从 aes-js 顶层入口导入 ECB 模式（4.x import 指向 ESM lib.esm/index.js）
// 旧版用的是 AES.ModeOfOperation.ecb，这里在 4.x 中等价于单独导出的 ECB 类
import { ECB } from 'aes-js';

// aes-cmac implementation (simplified) based on AES-128
function aesCmac(key, message){
  // Generate subkeys per RFC 4493
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
  // Split message into 16 byte blocks
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
      pad.set(lb); pad[lb.length]=0x80; // rest zeros
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

const aadStr = 'tech.yeez.key.manager';
const aad = new TextEncoder().encode(aadStr);
function hexToBytes(hex){
  const clean = hex.startsWith('0x')? hex.slice(2): hex;
  const arr = new Uint8Array(clean.length/2);
  for(let i=0;i<arr.length;i++){ arr[i] = parseInt(clean.substr(i*2,2),16); }
  return arr;
}
const cmac_key = hexToBytes('7965657a2e746563682e7374626f7800');

// emulate libsecp256k1 ecdh with custom hashfn by hashing compressed shared point (WebCrypto)
async function sha256Bytes(u8){
  const digest = await crypto.subtle.digest('SHA-256', u8);
  return new Uint8Array(digest);
}

function generatePublicKeyFromPrivateKey(priv){
  // Uncompressed (04 + x + y) then drop leading 0x04
  const full = getPublicKey(priv, false); // 65 bytes
  return full.slice(1); // 64 bytes
}

async function generateAESKeyFrom(pkey, skey){
  // expect pkey length 64, add 0x04
  if(pkey.length === 64){
    pkey = new Uint8Array([0x04,...pkey]);
  }
  // noble 返回压缩形式的共享点(33字节)时，将其再过一层 sha256，与 Node 端 hashfn 行为等价
  const sharedCompressed = getSharedSecret(skey, pkey, true); // 33 bytes
  const ecdhHash = await sha256Bytes(sharedCompressed); // 32 bytes
  const key_derive_key = aesCmac(cmac_key, ecdhHash);
  let derivation_buffer = new Uint8Array(aad.length + 4);
  derivation_buffer[0] = 0x01;
  derivation_buffer.set(aad,1);
  derivation_buffer[aad.length+1]=0;
  derivation_buffer[aad.length+2]=0x80;
  derivation_buffer[aad.length+3]=0x00;
  const derived_key = aesCmac(key_derive_key, derivation_buffer);
  return derived_key; // 16 bytes for AES-128-GCM
}

async function decryptMessage(privKeyHex, msg){
  const skey = hexToBytes(privKeyHex);
  const total = msg.length;
  const encrypted = msg.slice(0, total - 64 - 16 - 12);
  const liv = msg.slice(encrypted.length, total - 64 - 16);
  const pkey = msg.slice(encrypted.length + 12, total - 16); // 64 bytes
  const tag = msg.slice(total - 16);
  const enc_key = await generateAESKeyFrom(pkey, skey);
  // WebCrypto decrypt
  const key = await crypto.subtle.importKey('raw', enc_key, {name:'AES-GCM'}, false, ['decrypt']);
  const tad = new Uint8Array(64);
  tad.set(aad);
  tad[24] = 0x2; // prefix
  // Need concat encrypted+tag? WebCrypto expects separate tag appended to ciphertext (last 16 bytes). Already separated; we must reconstruct
  const cipherAll = new Uint8Array(encrypted.length + tag.length);
  cipherAll.set(encrypted,0); cipherAll.set(tag, encrypted.length);
  const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv: liv, additionalData: tad, tagLength:128}, key, cipherAll);
  // 与 Node 端逻辑保持一致：Node 在解密后返回的是原始明文字节（不是 ASCII hex），这里直接返回原始 bytes
  return new Uint8Array(plain);
}

export const BrowserCrypto = { decryptMessage, generatePublicKeyFromPrivateKey };
export default BrowserCrypto;
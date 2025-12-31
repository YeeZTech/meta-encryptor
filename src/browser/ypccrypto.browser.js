
import { ECB } from 'aes-js';
import { Buffer } from 'buffer';
import keccak256 from "keccak256";
import { sha256 } from "js-sha256";
import secp256k1 from "secp256k1";

function hashfn(x, y) {
  const version = new Uint8Array(33);

  const sha = sha256.create();

  version[0] = (y[31] & 1) === 0 ? 0x02 : 0x03;
  version.set(x, 1);
  sha.update(version);
  return new Uint8Array(sha.array());
}
function gen_ecdh_key_from(skey, pkey) {
  const out = new Uint8Array(32);
  const ecdhPointX = secp256k1.ecdh(pkey, skey, { hashfn }, out);
  return ecdhPointX;
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

const aadStr = 'tech.yeez.key.manager';
const aad = new TextEncoder().encode(aadStr);
function hexToBytes(hex){
  const clean = hex.startsWith('0x')? hex.slice(2): hex;
  const arr = new Uint8Array(clean.length/2);
  for(let i=0;i<arr.length;i++){ arr[i] = parseInt(hex.substr(i*2,2),16); }
  return arr;
}
const cmac_key = hexToBytes('7965657a2e746563682e7374626f7800');
let derivation_buffer = new Uint8Array(aad.length + 4);
 derivation_buffer[0] = 0x01;
  derivation_buffer.set(aad, 1);
  derivation_buffer[aad.length + 1] = 0;
  derivation_buffer[aad.length + 2] = 0x80;
  derivation_buffer[aad.length + 3] = 0x00;
  derivation_buffer = Buffer.from(derivation_buffer);

async function sha256Bytes(u8){
  const digest = await crypto.subtle.digest('SHA-256', u8);
  return new Uint8Array(digest);
}

function generatePublicKeyFromPrivateKey(skey){
  if (!secp256k1.privateKeyVerify(skey)) {
      throw new Error("invalid private key");
    }
    // false for compress
    // we ignore the first byte, which is '0x04' according to
    // https://davidederosa.com/basic-blockchain-programming/elliptic-curve-keys/;
    const pkey = secp256k1.publicKeyCreate(skey, false).subarray(1);

    return Buffer.from(pkey);
}

async function generateAESKeyFrom(pkey, skey){    
  if (pkey.length === 64) {
      const prefix = new Uint8Array([0x04]);
      pkey = new Uint8Array(pkey);
      pkey = Uint8Array.from([...prefix, ...pkey]);
    }
    const shared_key = gen_ecdh_key_from(skey, pkey);
    // The following algorithm is from ypc/stbox/src/tsgx/crypto/ecp.cpp
    const options = { returnAsBuffer: true };
    const key_derive_key = aesCmac(cmac_key, shared_key, options);
    const derived_key = aesCmac(key_derive_key, derivation_buffer, options);
    return derived_key;
}

async function decryptMessage(privKeyHex, msg){
  const skey = hexToBytes(privKeyHex);
  const total = msg.length;
  const encrypted = msg.slice(0, total - 64 - 16 - 12);
  const liv = msg.slice(encrypted.length, total - 64 - 16);
  const pkey = msg.slice(encrypted.length + 12, total - 16);
  const tag = msg.slice(total - 16);
  const enc_key = await generateAESKeyFrom(pkey, skey);
  const key = await crypto.subtle.importKey('raw', enc_key, {name:'AES-GCM'}, false, ['decrypt']);
  const tad = new Uint8Array(64);
  tad.set(aad);
  tad[24] = 0x2;
  const cipherAll = new Uint8Array(encrypted.length + tag.length);
  cipherAll.set(encrypted,0); cipherAll.set(tag, encrypted.length);
  const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv: liv, additionalData: tad, tagLength:128}, key, cipherAll);
  return new Uint8Array(plain);
}

const YPCCrypto = function () {
  if (!(this instanceof YPCCrypto)) {
    return new YPCCrypto();
  }

  const toUint8Array = (data) => {
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
  };

  const toKeccakInput = (v) => {
    if (v instanceof Uint8Array) {
      if (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength) {
        return v;
      }
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }

    if (v instanceof ArrayBuffer) {
      return new Uint8Array(v);
    }

    if (typeof v === 'string') {
      return new TextEncoder().encode(v);
    }

    try {
      return new Uint8Array(v);
    } catch (e) {
      throw new Error('keccak256 input must be Uint8Array-compatible: ' + typeof v);
    }
  };

  const toHex = (bytes) => {
    const arr = Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return arr.map(b => b.toString(16).padStart(2, '0')).join('');
  };

  this.generatePublicKeyFromPrivateKey = function (skey) {
    const skeyBytes = toUint8Array(skey);
    return generatePublicKeyFromPrivateKey(skeyBytes);
  };

  this.decryptMessage = async function (skey, msg) {
    const skeyBytes = toUint8Array(skey);
    const skeyHex = typeof skey === 'string' ? skey : toHex(skeyBytes);
    return await decryptMessage(skeyHex, toUint8Array(msg));
  };

  this.generatePrivateKey = function () {
    let privKey;
    do {
      privKey = new Uint8Array(32);
      crypto.getRandomValues(privKey);
    } while (!secp256k1.privateKeyVerify(privKey));
    return privKey;
  };

  this.generateAESKeyFrom = async function (pkey, skey) {
    return await generateAESKeyFrom(toUint8Array(pkey), toUint8Array(skey));
  };

  this._encryptMessage = async function (pkey, skey, msg, prefix) {
    const enc_key = await this.generateAESKeyFrom(pkey, skey);
    const msgBytes = toUint8Array(msg);
    
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const tad = new Uint8Array(64);
    tad.set(aad);
    tad[24] = prefix;

    const key = await crypto.subtle.importKey(
      'raw',
      enc_key,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        additionalData: tad,
        tagLength: 128
      },
      key,
      msgBytes
    );

    const encryptedBytes = new Uint8Array(encrypted);
    const tag = encryptedBytes.slice(-16);
    const ciphertext = encryptedBytes.slice(0, -16);

    const generatedPublicKey = this.generatePublicKeyFromPrivateKey(skey);
    const length = ciphertext.length + 64 + 16 + 12;
    const result = new Uint8Array(length);
    result.set(ciphertext, 0);
    result.set(iv, ciphertext.length);
    result.set(generatedPublicKey, ciphertext.length + 12);
    result.set(tag, ciphertext.length + 64 + 12);
    
    return result;
  };

  this.generateForwardSecretKey = async function (remote_pkey, skey) {
    const ots = this.generatePrivateKey();
    return await this._encryptMessage(remote_pkey, ots, skey, 0x1);
  };

  this.generateEncryptedInput = async function (local_pkey, input) {
    const ots = this.generatePrivateKey();
    const inputBytes = toUint8Array(input.buffer || input);
    return await this._encryptMessage(local_pkey, ots, inputBytes, 0x2);
  };

  this._decryptMessageWithPrefix = async function (skey, msg, prefix) {
    const skeyBytes = toUint8Array(skey);
    const skeyHex = typeof skey === 'string' ? skey : toHex(skeyBytes);
    const msgBytes = toUint8Array(msg);
    const total = msgBytes.length;
    
    const encrypted = msgBytes.slice(0, total - 64 - 16 - 12);
    const liv = msgBytes.slice(encrypted.length, total - 64 - 16);
    const pkey = msgBytes.slice(encrypted.length + 12, total - 16);
    const tag = msgBytes.slice(total - 16);
    
    const enc_key = await generateAESKeyFrom(pkey, skeyBytes);
    const key = await crypto.subtle.importKey('raw', enc_key, {name:'AES-GCM'}, false, ['decrypt']);
    const tad = new Uint8Array(64);
    tad.set(aad);
    tad[24] = prefix;
    const cipherAll = new Uint8Array(encrypted.length + tag.length);
    cipherAll.set(encrypted, 0);
    cipherAll.set(tag, encrypted.length);
    const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv: liv, additionalData: tad, tagLength:128}, key, cipherAll);
    return new Uint8Array(plain);
  };

  this.decryptForwardMessage = async function (skey, msg) {
    return await this._decryptMessageWithPrefix(skey, msg, 0x1);
  };

  const eth_hash_prefix = Buffer.from("\x19Ethereum Signed Message:\n32");

  this.signMessage = function (skey, raw) {

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

    /*
    const skeyBytes = toUint8Array(skey);

    const rawBytes = toKeccakInput(raw);
    const rawHash = keccak_256(rawBytes);

    const msg0 = new Uint8Array(eth_hash_prefix.length + rawHash.length);
    msg0.set(eth_hash_prefix);
    msg0.set(rawHash, eth_hash_prefix.length);

    const msg = keccak_256(msg0);

    const signature = sign(msg, skeyBytes, {prehash: false, extraEntropy:false, format: 'recovered'});
    const sig = new Uint8Array(65);
    sig.set(signature.subarray(1, 65), 0);
    sig[64] = signature[0] + 27;
    return sig;
    */
  };

  this.generateSignature = function (skey, epkey, ehash) {
    const epkeyBytes = toUint8Array(epkey);
    const ehashBytes = toUint8Array(ehash);
    const data = new Uint8Array(epkeyBytes.length + ehashBytes.length);
    data.set(epkeyBytes, 0);
    data.set(ehashBytes, epkeyBytes.length);
    return this.signMessage(skey, data);
  };

  this.generateFileNameFromPKey = function (pkey) {
    const pkeyBytes = toUint8Array(pkey);
    const hex = toHex(pkeyBytes);
    return hex.slice(0, 8) + ".json";
  };

  this.generateFileContentFromSKey = function (skey) {
    const skeyBytes = toUint8Array(skey);
    const c = {};
    c["private_key"] = toHex(skeyBytes);
    c["public_key"] = toHex(this.generatePublicKeyFromPrivateKey(skeyBytes));
    return JSON.stringify(c);
  };
};

const browserCryptoInstance = new YPCCrypto();

export const BrowserCrypto = browserCryptoInstance;

export default YPCCrypto;

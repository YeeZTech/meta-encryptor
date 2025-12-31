import crypto from "crypto";
import keccak256 from "keccak256";
import secp256k1 from "secp256k1";
import { sha256 } from "js-sha256";
import { ECB } from 'aes-js';


const { randomBytes } = crypto;

function hashfn(x, y) {
  const version = new Uint8Array(33);

  const sha = sha256.create();

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
  const ecdhPointX = secp256k1.ecdh(pkey, skey, { hashfn }, Buffer.alloc(32));
  return ecdhPointX;
}

const YPCCrypto = function () {
  if (!(this instanceof YPCCrypto)) {
    return new YPCCrypto();
  }

  const algorithm = "aes-128-gcm";
  const aad = Buffer.from("tech.yeez.key.manager");

  //let cmac_key = new Uint8Array(16)
  //cmac_key.set('yeez.tech.stbox')
  let cmac_key = Buffer.from("7965657a2e746563682e7374626f7800", "hex");

  let derivation_buffer = new Uint8Array(aad.length + 4);
  derivation_buffer[0] = 0x01;
  derivation_buffer.set(aad, 1);
  derivation_buffer[aad.length + 1] = 0;
  derivation_buffer[aad.length + 2] = 0x80;
  derivation_buffer[aad.length + 3] = 0x00;
  derivation_buffer = Buffer.from(derivation_buffer);

  this.generatePrivateKey = function () {
    let privKey;
    do {
      privKey = randomBytes(32);
    } while (!secp256k1.privateKeyVerify(privKey));
    return privKey;
  };

  this.generatePublicKeyFromPrivateKey = function (skey) {
    if (!secp256k1.privateKeyVerify(skey)) {
      alert("invalid private key");
    }
    // false for compress
    // we ignore the first byte, which is '0x04' according to
    // https://davidederosa.com/basic-blockchain-programming/elliptic-curve-keys/;
    const pkey = secp256k1.publicKeyCreate(skey, false).subarray(1);

    return Buffer.from(pkey);
  };

  this.generateAESKeyFrom = function (pkey, skey) {
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
  };

  this._encryptMessage = function (pkey, skey, msg, prefix) {
    const enc_key = this.generateAESKeyFrom(pkey, skey);
    let iv = randomBytes(12);
    let cipher = crypto.createCipheriv(algorithm, enc_key, iv);
    const tad = new Uint8Array(64);
    tad.set(aad);
    tad[24] = prefix;

    cipher.setAAD(Buffer.from(tad), {
      plaintextLength: msg.length || msg.byteLength,
    });
    const message = Buffer.from(msg).toString('hex');
    let encrypted = cipher.update(message, "hex", "hex");
    encrypted += cipher.final("hex");
    encrypted = Buffer.from(encrypted, "hex");
    const tag = cipher.getAuthTag();
    const length =
      (encrypted.length || encrypted.byteLength) +
      64 + // public key size
      // sig_size + // sinature_size
      16 + // gcm tag size
      12; //iv size

    cipher = new Uint8Array(length);
    cipher.set(encrypted);
    cipher.set(iv, encrypted.length);
    let generatedPublicKey = this.generatePublicKeyFromPrivateKey(skey);
    cipher.set(generatedPublicKey, encrypted.length + 12);
    cipher.set(tag, (encrypted.length || encrypted.byteLength) + 64 + 12);
    const result = Buffer.from(cipher);
    return result;
  };

  this.generateForwardSecretKey = function (remote_pkey, skey) {
    const ots = this.generatePrivateKey();

    return this._encryptMessage(remote_pkey, ots, skey, 0x1);
  };
  this.generateEncryptedInput = function (local_pkey, input) {
    const ots = this.generatePrivateKey();
    return this._encryptMessage(local_pkey, ots, input.buffer, 0x2);
  };
  // 调用
  this._decryptMessageWithPrefix = function (skey, msg, prefix) {
    const encrypted = msg.slice(0, (msg.length || msg.byteLength) - 64 - 16 - 12);
    const liv = msg.slice(encrypted.length, (msg.length || msg.byteLength) - 64 - 16);
    const pkey = msg.slice(encrypted.length + 12, (msg.length || msg.byteLength) - 16);
    const tag = msg.slice((msg.length || msg.byteLength) - 16);
    const enc_key = this.generateAESKeyFrom(pkey, skey);
    const decipher = crypto.createDecipheriv(algorithm, enc_key, liv);
    decipher.setAuthTag(tag);
    const tad = new Uint8Array(64);
    tad.set(aad);
    tad[24] = prefix;
    decipher.setAAD(Buffer.from(tad), {
      plaintextLength: encrypted.length,
    });
    let dec = decipher.update(encrypted, undefined, "hex");
    dec += decipher.final("hex");
    return Buffer.from(dec, "hex");
  };

  this.decryptMessage = function (skey, msg) {
    return this._decryptMessageWithPrefix(skey, msg, 0x2);
  };

  this.decryptForwardMessage = function (skey, msg) {
    return this._decryptMessageWithPrefix(skey, msg, 0x1);
  };

  const eth_hash_prefix = Buffer.from("\x19Ethereum Signed Message:\n32");

  this.signMessage = function(skey, raw) {
    let raw_hash = keccak256(raw);
    let msg = new Uint8Array(eth_hash_prefix.length + raw_hash.length)
    msg.set(eth_hash_prefix)
    msg.set(raw_hash, eth_hash_prefix.length)
    msg = keccak256(Buffer.from(msg))

    const rsig = secp256k1.ecdsaSign(msg, skey);
    const sig = new Uint8Array(65);
    sig.set(rsig.signature);
    sig[64] = rsig.recid + 27;
    return Buffer.from(sig);
  };

  this.generateSignature = function (skey, epkey, ehash) {
    const data = new Uint8Array(epkey.length + ehash.length);

    data.set(epkey, 0);
    data.set(ehash, epkey.length);
    return this.signMessage(skey, Buffer.from(data));
  };

  this.generateFileNameFromPKey = function (pkey) {
    return pkey.toString("hex").slice(0, 8) + ".json";
  };

  this.generateFileContentFromSKey = function (skey) {
    const c = {};
    c["private_key"] = skey.toString("hex");
    c["public_key"] =
      this.generatePublicKeyFromPrivateKey(skey).toString("hex");
    return JSON.stringify(c);
  };
};

export default YPCCrypto;

import crypto from "crypto";
import secp256k1 from "secp256k1";
import {
  generateAESKeyFrom, generatePublicKeyFromPrivateKey, aad, 
  signMessage } from '../common/ypccrypto.common.js';


const { randomBytes } = crypto;

const YPCCrypto = function () {
  if (!(this instanceof YPCCrypto)) {
    return new YPCCrypto();
  }

  const algorithm = "aes-128-gcm";

  this.generatePrivateKey = function () {
    let privKey;
    do {
      privKey = randomBytes(32);
    } while (!secp256k1.privateKeyVerify(privKey));
    return privKey;
  };

  this.generatePublicKeyFromPrivateKey = generatePublicKeyFromPrivateKey;

  this.generateAESKeyFrom = generateAESKeyFrom;

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

  this.signMessage = signMessage;

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

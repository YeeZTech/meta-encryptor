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
    } while (!secp256k1.privateKeyVerify(new Uint8Array(privKey)));
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

    // Buffer 直通：不再 hex 编解码往返（每个 item 省两次 2x 体积的字符串拷贝）
    const message = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    cipher.setAAD(Buffer.from(tad), {
      plaintextLength: message.length,
    });
    const encrypted = Buffer.concat([cipher.update(message), cipher.final()]);
    const tag = cipher.getAuthTag();
    const length =
      encrypted.length +
      64 + // public key size
      // sig_size + // sinature_size
      16 + // gcm tag size
      12; //iv size

    // 布局：encrypted ‖ iv(12) ‖ pubkey(64) ‖ tag(16)
    const result = Buffer.allocUnsafe(length);
    encrypted.copy(result, 0);
    iv.copy(result, encrypted.length);
    const generatedPublicKey = this.generatePublicKeyFromPrivateKey(skey);
    result.set(generatedPublicKey, encrypted.length + 12);
    tag.copy(result, encrypted.length + 12 + 64);
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
  this._decryptMessageWithPrefix = function (skey, msg, prefix) {
    // 统一成 Buffer 视图：下面的 subarray 全是零拷贝（Uint8Array.slice 会复制）
    const m = Buffer.isBuffer(msg)
      ? msg
      : ArrayBuffer.isView(msg)
        ? Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength)
        : Buffer.from(msg);
    const encLen = m.length - 64 - 16 - 12;
    const encrypted = m.subarray(0, encLen);
    const liv = m.subarray(encLen, encLen + 12);
    const pkey = m.subarray(encLen + 12, m.length - 16);
    const tag = m.subarray(m.length - 16);
    const enc_key = this.generateAESKeyFrom(pkey, skey);
    const decipher = crypto.createDecipheriv(algorithm, enc_key, liv);
    decipher.setAuthTag(tag);
    const tad = new Uint8Array(64);
    tad.set(aad);
    tad[24] = prefix;
    decipher.setAAD(Buffer.from(tad), {
      plaintextLength: encrypted.length,
    });
    // Buffer 直通：不再 hex 编解码往返
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
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

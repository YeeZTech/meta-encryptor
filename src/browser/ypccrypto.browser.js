import secp256k1 from "secp256k1";
import { hexToBytes, toUint8Array, toHex, 
  generateAESKeyFrom, generatePublicKeyFromPrivateKey, aad, 
  signMessage} from '../common/ypccrypto.common.js';

// helpers and constants imported from shared module

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


  // use shared toUint8Array / toHex from common module

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

  this.signMessage = signMessage;

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

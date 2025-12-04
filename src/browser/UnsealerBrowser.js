// 使用浏览器兼容版本的 header_util，避免 bytebuffer 依赖问题
import { ntpackage2batch, fromNtInput } from './header_util.browser.js';
import { HeaderSize, MagicNum, CurrentBlockFileVersion } from '../limits.js';
// SSR兼容：BrowserCrypto 在不同构建环境下导出方式不同
import * as BrowserCryptoModule from './ypccrypto.browser.js';
const BrowserCrypto = BrowserCryptoModule.default || BrowserCryptoModule.BrowserCrypto || BrowserCryptoModule;

// SSR兼容：将 MagicNum 转换为 Uint8Array（避免 Buffer 依赖）
const MAGIC_NUM_BYTES = (() => {
  if (MagicNum instanceof Uint8Array) {
    return MagicNum;
  }
  // 如果 MagicNum 是 Buffer 或其他类型，转换为 Uint8Array
  if (MagicNum && typeof MagicNum === 'object' && 'buffer' in MagicNum) {
    return new Uint8Array(MagicNum.buffer, MagicNum.byteOffset || 0, MagicNum.byteLength || MagicNum.length);
  }
  // 如果 MagicNum 是字符串（hex），手动解析
  if (typeof MagicNum === 'string') {
    const hex = MagicNum.replace(/^0x/, '');
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return arr;
  }
  // 默认：MagicNum 应该是 "1fe2ef7f3ed18847" 的 hex 表示
  const hex = '1fe2ef7f3ed18847';
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return arr;
})();

// Incremental parser working on Uint8Array chunks.
export class UnsealerBrowser {
  constructor({ privateKeyHex, progressHandler } = {}) {
    this.accumulated = new Uint8Array(0);
    this.isHeaderReady = false;
    this.header = null;
    this.privateKeyHex = privateKeyHex;
    this.progressHandler = progressHandler;
    this.readItemCount = 0;
    this.processedBytes = 0;
    this.writeBytes = 0;
  // omit running hash in browser sample to avoid Node Buffer dependency
    this.totalItems = 0;
    this.finished = false;
  }

  _append(chunk){
    const a = new Uint8Array(this.accumulated.length + chunk.length);
    a.set(this.accumulated,0); a.set(chunk, this.accumulated.length);
    this.accumulated = a;
  }

  async _tryParseHeader(){
    if(this.isHeaderReady) return;
    if(this.accumulated.length < HeaderSize) return;
    const headerBytes = this.accumulated.slice(0, HeaderSize);
    const dv = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    const readUint64LE = (off)=>{ const lo = dv.getUint32(off, true); const hi = dv.getUint32(off+4, true); return hi * 0x100000000 + lo; };
    const version_number = readUint64LE(8);
    if(version_number !== CurrentBlockFileVersion){
      throw new Error('Unsupported version: '+version_number);
    }
    const magic = headerBytes.slice(0,8);
    // SSR兼容：使用纯 Uint8Array 比较，避免 Buffer 依赖
    if(magic.length !== MAGIC_NUM_BYTES.length){
      throw new Error('Magic number mismatch');
    }
    for(let i = 0; i < magic.length; i++){
      if(magic[i] !== MAGIC_NUM_BYTES[i]){
        throw new Error('Magic number mismatch');
      }
    }
    const item_number = readUint64LE(24);
    this.totalItems = item_number;
    this.accumulated = this.accumulated.slice(HeaderSize);
    this.isHeaderReady = true;
  }

  async _extractOne(){
    if(!this.isHeaderReady) return null;
    if(this.accumulated.length < 8) return null;
  // length prefix (little-endian uint64)
  const dv = new DataView(this.accumulated.buffer, this.accumulated.byteOffset, this.accumulated.byteLength);
  const lo = dv.getUint32(0, true); const hi = dv.getUint32(4, true);
  const itemSize = hi * 0x100000000 + lo;
    if(this.accumulated.length < 8 + itemSize) return null;
    const cipher = this.accumulated.slice(8, 8 + itemSize);
    this.accumulated = this.accumulated.slice(8 + itemSize);
    this.processedBytes += (8 + itemSize);
    // decrypt
    let msg = await BrowserCrypto.decryptMessage(this.privateKeyHex, cipher);
    if(!msg || msg.length < 12){
      console.warn('Decrypted msg too short:', msg?.length || 0);
      return [];
    }
    // If header doesn't match expected package id, try ASCII-hex fallback
    const isPkgId = (m)=> m[0]===0xd8 && m[1]===0xe8 && m[2]===0xc4 && m[3]===0x82; // 0x82c4e8d8 LE
    if(!isPkgId(msg)){
      const looksAsciiHex = (m)=>{
        const n = Math.min(m.length, 32);
        for(let i=0;i<n;i++){
          const c=m[i];
          const isHex=(c>=0x30&&c<=0x39)||(c>=0x41&&c<=0x46)||(c>=0x61&&c<=0x66);
          if(!isHex) return false;
        }
        return (m.length % 2)===0;
      };
      if(looksAsciiHex(msg)){
        try{
          const txt = new TextDecoder().decode(msg);
          const clean = txt.replace(/[^0-9a-fA-F]/g,'');
          const out = new Uint8Array(clean.length/2);
          for(let i=0;i<out.length;i++) out[i]=parseInt(clean.substr(i*2,2),16);
          if(out.length>=12 && isPkgId(out)){
            console.warn('ASCII-hex decrypted payload detected; converted to bytes');
            msg = out;
          }
        }catch(e){ /* ignore */ }
      }
    }
    const batch = ntpackage2batch(msg);
    let outputBuffers = [];
    for(let i=0;i<batch.length;i++){
      let it = batch[i];
      // Normalize to Uint8Array for browser compatibility
      if(it instanceof ArrayBuffer){
        it = new Uint8Array(it);
      } else if (ArrayBuffer.isView(it)) {
        it = new Uint8Array(it.buffer, it.byteOffset, it.byteLength);
      }
      const b = fromNtInput(it);
      outputBuffers.push(b);
      this.writeBytes += b.length;
  // omit rolling hash in browser demo
    }
    this.readItemCount += 1;
    if(this.progressHandler){
      this.progressHandler(this.totalItems, this.readItemCount, this.processedBytes, this.writeBytes);
    }
    if(this.readItemCount === this.totalItems){
      this.finished = true;
    }
    return outputBuffers;
  }

  async pushChunk(chunk){
    this._append(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    await this._tryParseHeader();
    const results = [];
    while(true){
      const r = await this._extractOne();
      if(!r) break;
      results.push(...r);
    }
    return results; // array of Uint8Array plaintext segments
  }

  isDone(){return this.finished;}
}

export async function unsealStream(fetchResponse, {privateKeyHex, onChunk, progressHandler}){
  const reader = fetchResponse.body.getReader();
  const un = new UnsealerBrowser({privateKeyHex, progressHandler});
  let all = [];
  while(true){
    const {done, value} = await reader.read();
    if(done) break;
    const outs = await un.pushChunk(value);
    for (const o of outs){
      if(onChunk){
        // support async writer (e.g., streaming to file)
        await onChunk(o);
      }
      all.push(o);
    }
  }
  return all;
}

export default { UnsealerBrowser, unsealStream };
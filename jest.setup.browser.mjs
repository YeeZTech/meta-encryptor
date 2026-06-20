// jest.setup.browser.mjs

globalThis.JS_SHA256_NO_NODE_JS = true;
globalThis.JS_SHA256_NO_COMMON_JS = true;
globalThis.JS_SHA3_NO_NODE_JS = true;
globalThis.JS_SHA3_NO_COMMON_JS = true;

await import('js-sha256/src/sha256.js');
await import('js-sha3/src/sha3.js');

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./jest.hooks.cjs');

// 模拟浏览器的 TextEncoder 和 TextDecoder API
if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = await import('node:util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}
if(typeof globalThis.crypto === 'undefined' || globalThis.crypto.subtle === undefined) {
  const { webcrypto } = await import('crypto');
  globalThis.crypto = webcrypto;
  globalThis.crypto.subtle = webcrypto.subtle;
}
// Polyfill Fetch API for Node < 18 / jsdom
if (typeof globalThis.Response === 'undefined') {
  // minimal Response polyfill
  globalThis.Response = class Response {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status || 200;
      this.statusText = init.statusText || '';
      this.headers = new Map(Object.entries(init.headers || {}));
      this.ok = this.status >= 200 && this.status < 300;
    }
    get headers() { return this._headers; }
    set headers(v) { this._headers = v; }
    async arrayBuffer() {
      if (typeof this.body === 'string') return new TextEncoder().encode(this.body).buffer;
      if (this.body instanceof Uint8Array) return this.body.buffer.slice(this.body.byteOffset, this.body.byteOffset + this.body.byteLength);
      return new ArrayBuffer(0);
    }
    async text() {
      if (typeof this.body === 'string') return this.body;
      if (this.body instanceof Uint8Array) return new TextDecoder().decode(this.body);
      return '';
    }
  };
}
// Polyfill Web Streams for Node < 18 / jsdom
if (typeof globalThis.TransformStream === 'undefined') {
  const { TransformStream } = await import('node:stream/web');
  globalThis.TransformStream = TransformStream;
}
if (typeof globalThis.ReadableStream === 'undefined') {
  const { ReadableStream } = await import('node:stream/web');
  globalThis.ReadableStream = ReadableStream;
}
if (typeof globalThis.WritableStream === 'undefined') {
  const { WritableStream } = await import('node:stream/web');
  globalThis.WritableStream = WritableStream;
}
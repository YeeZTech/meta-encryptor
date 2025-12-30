// jest.setup.browser.mjs

import { glob } from 'node:fs';

// 模拟浏览器的 TextEncoder 和 TextDecoder API
if (typeof globalThis.TextEncoder === 'undefined') {
  // 从 node:util 中导入 Node.js 内置的 TextEncoder/TextDecoder（Node.js 16+ 自带）
  const { TextEncoder, TextDecoder } = await import('node:util');
  // 挂载到全局对象（jsdom 环境中 globalThis 对应 window/global）
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}
if(typeof globalThis.crypto === 'undefined' || globalThis.crypto.subtle === undefined) {
  const { webcrypto } = await import('crypto');
  globalThis.crypto = webcrypto;
  globalThis.crypto.subtle = webcrypto.subtle;
}
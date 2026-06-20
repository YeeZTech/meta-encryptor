import { Buffer } from 'buffer';

import 'js-sha3/src/sha3.js';

export default function keccak256(data) {
  const input = data instanceof Uint8Array ? data : Buffer.from(data);
  const fn = globalThis.keccak256;
  if (typeof fn !== 'function') {
    const hint = fn === undefined ? 'undefined' : typeof fn;
    throw new Error(`keccak256 is not a function (globalThis.keccak256 is ${hint})`);
  }
  return Buffer.from(fn(input), 'hex');
}

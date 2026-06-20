import { sha256 } from 'js-sha256';
import sha3Pkg from 'js-sha3';
import { Buffer } from 'buffer';

const { keccak256: keccak256Hex } = sha3Pkg;

globalThis.sha256 = sha256;
globalThis.keccak256 = (data) => {
  const input = data instanceof Uint8Array ? data : Buffer.from(data);
  return keccak256Hex(input);
};

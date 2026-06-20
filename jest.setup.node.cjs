const { createRequire } = require('module');
const path = require('path');

const req = createRequire(path.join(__dirname, 'package.json'));

globalThis.sha256 = req('js-sha256').sha256;

const sha3 = req('js-sha3');
const { Buffer } = req('buffer');

globalThis.keccak256 = (data) => {
  const input = data instanceof Uint8Array ? data : Buffer.from(data);
  return sha3.keccak256(input);
};

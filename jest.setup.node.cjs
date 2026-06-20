const { createRequire } = require('module');
const path = require('path');

const req = createRequire(path.join(__dirname, 'package.json'));

// sha256 and keccak256 are now imported directly by consumer modules via @noble/hashes

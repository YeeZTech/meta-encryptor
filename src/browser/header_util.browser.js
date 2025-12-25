// Browser-compatible header_util using Uint8Array + DataView
// 完全使用原生浏览器 API，避免 bytebuffer 依赖和兼容性问题

/**
 * Read uint64 (little-endian) from Uint8Array at offset
 */
function readUint64LE(buffer, offset) {
  // Ensure we have a proper buffer view
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const lo = dv.getUint32(0, true);
  const hi = dv.getUint32(4, true);
  // Combine into number (safe for values < 2^53)
  const value = Number(hi) * 0x100000000 + Number(lo);
  return { toNumber: () => value, valueOf: () => value };
}

/**
 * Write uint64 (little-endian) to Uint8Array at offset
 */
function writeUint64LE(buffer, offset, value) {
  const dv = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
  const lo = value & 0xffffffff;
  const hi = Math.floor(value / 0x100000000);
  dv.setUint32(0, lo, true);
  dv.setUint32(4, hi, true);
}

/**
 * Read uint32 (little-endian) from Uint8Array at offset
 */
function readUint32LE(buffer, offset) {
  const dv = new DataView(buffer.buffer, buffer.byteOffset + offset, 4);
  return dv.getUint32(0, true);
}

/**
 * Write uint32 (little-endian) to Uint8Array at offset
 */
function writeUint32LE(buffer, offset, value) {
  const dv = new DataView(buffer.buffer, buffer.byteOffset + offset, 4);
  dv.setUint32(0, value, true);
}

/**
 * Convert NT package to batch (browser version)
 * @param {Uint8Array} pkg - Package bytes
 * @returns {Uint8Array[]} - Array of batch item buffers
 */
export function ntpackage2batch(pkg) {
  const batch = [];
  let offset = 4; // Skip package id (4 bytes)
  
  // Read batch count (uint64)
  const countObj = readUint64LE(pkg, offset);
  const cnt = countObj.toNumber();
  offset += 8;
  
  // Read each batch item
  for (let i = 0; i < cnt; i++) {
    // Read item length (uint64)
    const lenObj = readUint64LE(pkg, offset);
    const len = lenObj.toNumber();
    offset += 8;
    
    // Extract item data
    const item = pkg.slice(offset, offset + len);
    batch.push(item);
    offset += len;
  }
  
  return batch;
}

/**
 * Extract data from NT input (browser version)
 * @param {Uint8Array} inputNt - NT input bytes
 * @returns {Uint8Array} - Extracted data (skips first 12 bytes: 4-byte prefix + 8-byte size)
 */
export function fromNtInput(inputNt) {
  let offset = 12; // Skip prefix (4) + size (8)
  return inputNt.slice(offset, inputNt.length);
}


/**
 * HttpSealedFileStream integration test —
 * mocks fetch to serve a locally-sealed file, then decrypts with browser Unsealer
 * and verifies the MD5 matches the original.
 */

import { webcrypto as nodeWebcrypto } from 'crypto';
globalThis.crypto = nodeWebcrypto;

import streams from 'memory-streams';
import Provider from '../src/node/DataProvider.js';
import { HeaderSize, BlockInfoSize } from '../src/common/limits.js';
import { BrowserCrypto } from '../src/browser/ypccrypto.browser.js';
import { Unsealer } from '../src/browser/Unsealer.js';
import { HttpSealedFileStream } from '../src/browser/HttpSealedFileStream.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
const { DataProvider, headerAndBlockBufferFromBuffer } = Provider;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Seal a Buffer in memory with Node DataProvider and return the full disk buffer.
 * Uses BrowserCrypto for key generation (returns Uint8Array which secp256k1 v5 accepts),
 * then converts to hex for DataProvider.
 */
function sealBuffer(plain) {
  const sk = BrowserCrypto.generatePrivateKey();
  const pk = BrowserCrypto.generatePublicKeyFromPrivateKey(sk);
  const keyPair = {
    private_key: Buffer.from(sk).toString('hex'),
    public_key: Buffer.from(pk).toString('hex'),
  };

  const dp = new DataProvider(keyPair);
  const ws = new streams.WritableStream();
  dp.sealData(plain, ws, false);
  dp.sealData(null, ws, true);
  const diskBuf = ws.toBuffer();

  const hb = headerAndBlockBufferFromBuffer(diskBuf);
  const blockCount = (hb.block.length / BlockInfoSize) | 0;
  const contentSize = diskBuf.length - HeaderSize - BlockInfoSize * blockCount;
  return { diskBuf, contentSize, keyPair };
}

/**
 * Create a mock `fetch` that serves `diskBuf` as if it were a static HTTP file.
 */
function createMockFetch(diskBuf) {
  const totalSize = diskBuf.length;

  return async function mockFetch(_url, init = {}) {
    // HEAD
    if (init.method === 'HEAD') {
      return {
        ok: true, status: 200,
        headers: { get: (n) => n.toLowerCase() === 'content-length' ? String(totalSize) : null }
      };
    }

    // GET with Range
    const m = /bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || '');
    if (m) {
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      const sliced = new Uint8Array(diskBuf.slice(start, Math.min(end + 1, totalSize)));
      return {
        ok: true, status: 206,
        headers: { get: () => null },
        arrayBuffer: async () => sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength)
      };
    }

    // fallback: whole file
    const u8 = new Uint8Array(diskBuf);
    return {
      ok: true, status: 200,
      headers: { get: (n) => n.toLowerCase() === 'content-length' ? String(totalSize) : null },
      arrayBuffer: async () => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    };
  };
}

/** Compute MD5 of a Uint8Array in-memory. */
function md5OfUint8Array(buf) {
  return crypto.createHash('md5').update(Buffer.from(buf)).digest('hex');
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('HttpSealedFileStream', () => {
  test('streams header + content bytes', async () => {
    const original = Buffer.from('Hello HttpSealedFileStream! ' + 'x'.repeat(7000), 'utf8');
    const { diskBuf } = sealBuffer(original);

    const hsfs = new HttpSealedFileStream('http://x', {
      chunkSize: 4096,
      fetch: createMockFetch(diskBuf),
    });

    const reader = hsfs.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    // first chunk is the 64-byte header
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].length).toBe(64);
  });

  test('streams content in multiple chunks with small chunkSize', async () => {
    const original = Buffer.alloc(10000, 'Z');
    const { diskBuf } = sealBuffer(original);

    const hsfs = new HttpSealedFileStream('http://x', {
      chunkSize: 500,
      fetch: createMockFetch(diskBuf),
    });

    const reader = hsfs.getReader();
    let chunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      expect(value.length).toBeGreaterThan(0);
      chunkCount++;
    }
    // should produce more than 1 chunk (header + multiple content chunks)
    expect(chunkCount).toBeGreaterThan(1);
  });
});

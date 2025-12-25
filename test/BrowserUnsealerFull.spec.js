// Browser Unsealer full test - similar to Unsealer.spec.js but using browser crypto
import { webcrypto as nodeWebcrypto } from 'crypto';
globalThis.crypto = nodeWebcrypto;

import streams from 'memory-streams';
import Provider from '../src/DataProvider.js';
import { BlockInfoSize, HeaderSize } from '../src/limits.js';
import { BrowserCrypto } from '../src/browser/ypccrypto.browser.js';
import { UnsealerBrowser } from '../src/browser/UnsealerBrowser.js';
import { calculateMD5, generateFileWithSize } from './helper';
import fs from 'fs';
import path from 'path';

const { DataProvider, headerAndBlockBufferFromBuffer } = Provider;

// Helper function to convert Uint8Array to Buffer for MD5 calculation
function uint8ArrayToBuffer(uint8Array) {
  return Buffer.from(uint8Array);
}

// Helper function to convert Buffer to Uint8Array
function bufferToUint8Array(buffer) {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

async function sealAndUnsealFileBrowser(src) {
  // Generate key pair using browser crypto
  const sk = BrowserCrypto.generatePrivateKey();
  const pk = BrowserCrypto.generatePublicKeyFromPrivateKey(sk);
  const keyPair = { 
    private_key: typeof sk === 'string' ? sk : Buffer.from(sk).toString('hex'), 
    public_key: typeof pk === 'string' ? pk : Buffer.from(pk).toString('hex') 
  };

  // Encrypt using Node DataProvider (since browser doesn't have Sealer stream)
  const dp = new DataProvider(keyPair);
  const ws = new streams.WritableStream();
  
  // Read source file and encrypt it in chunks
  const fileContent = fs.readFileSync(src);
  const chunkSize = 64 * 1024; // 64KB chunks
  for (let offset = 0; offset < fileContent.length; offset += chunkSize) {
    const chunk = fileContent.slice(offset, Math.min(offset + chunkSize, fileContent.length));
    dp.sealData(chunk, ws, false);
  }
  dp.sealData(null, ws, true);
  
  const diskBuf = ws.toBuffer();
  
  // Extract header and content
  const hb = headerAndBlockBufferFromBuffer(diskBuf);
  expect(hb).toBeTruthy();
  const header = hb.header;
  const blockCount = (hb.block.length / BlockInfoSize) | 0;
  const contentSize = diskBuf.length - HeaderSize - BlockInfoSize * blockCount;
  const content = diskBuf.slice(0, contentSize);
  const streamBuf = Buffer.concat([header, content]);
  
  // Decrypt using browser UnsealerBrowser
  const un = new UnsealerBrowser({ privateKeyHex: keyPair.private_key });
  const chunks = [];
  
  // Feed data in chunks to simulate streaming
  const feedChunkSize = 1024; // 1KB chunks for testing
  for (let offset = 0; offset < streamBuf.length; offset += feedChunkSize) {
    const chunk = streamBuf.slice(offset, Math.min(offset + feedChunkSize, streamBuf.length));
    const decryptedChunks = await un.pushChunk(bufferToUint8Array(chunk));
    chunks.push(...decryptedChunks);
  }
  
  // Merge all decrypted chunks
  const mergedBuffers = chunks.map(chunk => 
    Buffer.from(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
  );
  const decryptedContent = Buffer.concat(mergedBuffers);
  
  // Verify content matches
  const originalMD5 = await calculateMD5(src);
  const decryptedFile = path.join(path.dirname(src), path.basename(src) + '.browser.unsealed');
  fs.writeFileSync(decryptedFile, decryptedContent);
  const decryptedMD5 = await calculateMD5(decryptedFile);
  
  expect(originalMD5.length > 0).toBe(true);
  expect(originalMD5).toStrictEqual(decryptedMD5);
  
  // Cleanup
  fs.unlinkSync(decryptedFile);
  
  return { keyPair, originalMD5, decryptedMD5 };
}

describe('Browser Unsealer Full Test', () => {
  test('should encrypt and decrypt small file', async () => {
    const src = './rollup.config.js';
    await sealAndUnsealFileBrowser(src);
  }, 30000);

  test('should encrypt and decrypt medium file', async () => {
    const src = './README.en.md';
    await sealAndUnsealFileBrowser(src);
  }, 30000);

  test('should encrypt and decrypt large file', async () => {
    const src = 'BrowserUnsealerLarge.file';
    try {
      fs.unlinkSync(src);
    } catch (err) {}
    
    // Generate 100MB file
    generateFileWithSize(src, 1024 * 1024 * 100);
    await sealAndUnsealFileBrowser(src);
    
    try {
      fs.unlinkSync(src);
    } catch (err) {}
  }, 300000);

  test('should handle multiple chunks correctly', async () => {
    // Test with small data in multiple batches
    const sk = BrowserCrypto.generatePrivateKey();
    const pk = BrowserCrypto.generatePublicKeyFromPrivateKey(sk);
    const keyPair = { 
      private_key: typeof sk === 'string' ? sk : Buffer.from(sk).toString('hex'), 
      public_key: typeof pk === 'string' ? pk : Buffer.from(pk).toString('hex') 
    };

    const dp = new DataProvider(keyPair);
    const ws = new streams.WritableStream();
    
    // Seal multiple small items
    const inputs = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    for (const input of inputs) {
      dp.sealData(Buffer.from(input, 'utf8'), ws, false);
    }
    dp.sealData(null, ws, true);
    
    const diskBuf = ws.toBuffer();
    const hb = headerAndBlockBufferFromBuffer(diskBuf);
    const header = hb.header;
    const blockCount = (hb.block.length / BlockInfoSize) | 0;
    const contentSize = diskBuf.length - HeaderSize - BlockInfoSize * blockCount;
    const content = diskBuf.slice(0, contentSize);
    const streamBuf = Buffer.concat([header, content]);
    
    // Decrypt with UnsealerBrowser
    const un = new UnsealerBrowser({ privateKeyHex: keyPair.private_key });
    const outputs = [];
    
    // Feed in various chunk sizes to test robustness
    let offset = 0;
    const sizes = [13, 7, 1024, 5, 256, 512];
    let idx = 0;
    while (offset < streamBuf.length) {
      const n = Math.min(streamBuf.length - offset, sizes[idx % sizes.length]);
      const part = streamBuf.slice(offset, offset + n);
      const outs = await un.pushChunk(bufferToUint8Array(part));
      outputs.push(...outs);
      offset += n;
      idx++;
    }
    
    // Merge outputs
    const merged = Buffer.concat(outputs.map(b => Buffer.from(b)));
    expect(merged.toString('utf8')).toBe(inputs.join(''));
  }, 30000);
});


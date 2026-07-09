/**
 * Callback wiring tests for browser download pipeline.
 *
 * Layer 1: mocked HttpSealedFileStream + Unsealer — fast smoke that pipeThrough
 *          invokes onDownloadReady / onProgress.
 * Layer 2: see downloadUnsealedCallbacks.spec.mjs — downloadUnsealed orchestration
 *          (onLog / onSuccess / onError + callback forwarding).
 *
 * Run alone:
 *   node --experimental-vm-modules node_modules/.bin/jest --config jest.config.browser.mjs test/downloadCallbacks.spec.mjs
 */

import { jest } from '@jest/globals';
import { webcrypto as nodeWebcrypto } from 'crypto';

globalThis.crypto = nodeWebcrypto;

// ---------------------------------------------------------------------------
// Layer 1 — mocked stream / unsealer
// ---------------------------------------------------------------------------

let sharedReadable;
const PLAIN_BYTES = new TextEncoder().encode('hello callback test');

jest.unstable_mockModule('../src/browser/HttpSealedFileStream.js', () => ({
  HttpSealedFileStream: jest.fn().mockImplementation(() => sharedReadable),
}));

jest.unstable_mockModule('../src/browser/Unsealer.js', () => ({
  Unsealer: jest.fn().mockImplementation(({ progressHandler }) => {
    const ts = new TransformStream({
      transform(chunk, controller) {
        progressHandler?.(PLAIN_BYTES.length, 1, chunk.length, chunk.length);
        controller.enqueue(chunk);
      },
    });
    return { readable: ts.readable, writable: ts.writable };
  }),
}));

const { blobDownloadAndDecrypt } = await import('../src/browser/blob_download.js');
const { streamDownloadAndDecrypt } = await import('../src/browser/stream_download.js');

function setupMockReadable() {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  sharedReadable = readable;
  setTimeout(() => { writer.write(PLAIN_BYTES); writer.close(); }, 0);
}

function stubBlobDom() {
  const origCOU = URL.createObjectURL;
  const origROU = URL.revokeObjectURL;
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => {};
  return () => {
    URL.createObjectURL = origCOU;
    URL.revokeObjectURL = origROU;
    HTMLAnchorElement.prototype.click = origClick;
  };
}

describe('download pipeline callbacks (mocked stream)', () => {
  beforeEach(() => {
    setupMockReadable();
    jest.clearAllMocks();
  });

  test('blobDownloadAndDecrypt invokes onDownloadReady once and onProgress', async () => {
    const events = [];
    const restore = stubBlobDom();
    try {
      await blobDownloadAndDecrypt('http://mock/file', 'a'.repeat(64), 'out.bin', {
        size: PLAIN_BYTES.length,
        onDownloadReady: () => events.push('ready'),
        onProgress: (...args) => events.push(['progress', ...args]),
      });
    } finally {
      restore();
    }

    expect(events.filter((e) => e === 'ready')).toHaveLength(1);
    expect(events.some((e) => Array.isArray(e) && e[0] === 'progress')).toBe(true);
    const readyIdx = events.indexOf('ready');
    const firstProgressIdx = events.findIndex((e) => Array.isArray(e) && e[0] === 'progress');
    expect(readyIdx).toBeLessThan(firstProgressIdx);
  });

  test('streamDownloadAndDecrypt invokes onDownloadReady once and onProgress', async () => {
    const events = [];
    const writable = new WritableStream({ write() {} });

    await streamDownloadAndDecrypt('http://mock/file', 'a'.repeat(64), 'out.bin', {
      writable,
      size: PLAIN_BYTES.length,
      onDownloadReady: () => events.push('ready'),
      onProgress: (...args) => events.push(['progress', ...args]),
    });

    expect(events.filter((e) => e === 'ready')).toHaveLength(1);
    expect(events.some((e) => Array.isArray(e) && e[0] === 'progress')).toBe(true);
  });
});

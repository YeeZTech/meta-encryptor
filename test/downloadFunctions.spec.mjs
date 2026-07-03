/**
 * Unit tests for blobDownloadAndDecrypt and streamDownloadAndDecrypt.
 *
 * We mock HttpSealedFileStream + Unsealer to verify the wrapper logic
 * (Blob creation, DOM calls, progress callbacks, writable piping).
 * Full pipeline integration is tested in HttpSealedFileStream.spec.mjs
 * and BrowserUnsealer*.spec.mjs.
 */

import { jest } from '@jest/globals';
import { webcrypto as nodeWebcrypto } from 'crypto';
globalThis.crypto = nodeWebcrypto;
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null } });

// shared streams for mock implementations
let sharedReadable;

// ---- mock HttpSealedFileStream ----
jest.unstable_mockModule('../src/browser/HttpSealedFileStream.js', () => ({
  HttpSealedFileStream: jest.fn().mockImplementation(() => sharedReadable),
}));

// ---- mock Unsealer ----
jest.unstable_mockModule('../src/browser/Unsealer.js', () => ({
  Unsealer: jest.fn().mockImplementation(() => {
    const { readable, writable } = new TransformStream();
    return { readable, writable };
  }),
}));

const { blobDownloadAndDecrypt } = await import('../src/browser/blob_download.js');
const { streamDownloadAndDecrypt } = await import('../src/browser/stream_download.js');

const PLAIN_BYTES = new TextEncoder().encode('hello from mock');

function setupMocks() {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  sharedReadable = readable;
  setTimeout(() => { writer.write(PLAIN_BYTES); writer.close(); }, 0);
}

// ---------------------------------------------------------------------------

describe('blobDownloadAndDecrypt', () => {
  beforeEach(() => { setupMocks(); jest.clearAllMocks(); });

  test('creates Blob with decrypted content and triggers download', async () => {
    let blobContent = null;
    const origCOU = URL.createObjectURL;
    const origROU = URL.revokeObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {};
    URL.createObjectURL = (b) => { blobContent = b; return 'blob:mock'; };
    URL.revokeObjectURL = () => {};

    try {
      const logs = [];
      const result = await blobDownloadAndDecrypt(
        'http://mock/file', 'a'.repeat(64), 'out.bin',
        { log: (m) => logs.push(m) }
      );

      expect(result).toEqual({ ok: true });
      expect(logs.some(m => m.includes('Download complete'))).toBe(true);
      expect(blobContent).not.toBeNull();
    } finally {
      URL.createObjectURL = origCOU;
      URL.revokeObjectURL = origROU;
      HTMLAnchorElement.prototype.click = origClick;
    }
  });

  test('reports errors via log and throws', async () => {
    sharedReadable = new ReadableStream({
      start(c) { setTimeout(() => c.error(new Error('fetch fail')), 0); }
    });

    const logs = [];
    await expect(
      blobDownloadAndDecrypt('http://mock/file', 'a'.repeat(64), 'out.bin', { log: (m) => logs.push(m) })
    ).rejects.toThrow('fetch fail');
    expect(logs.some(m => m.includes('failed'))).toBe(true);
  }, 15000);
});

describe('streamDownloadAndDecrypt', () => {
  beforeEach(() => { setupMocks(); jest.clearAllMocks(); });

  test('writes decrypted data to provided writable', async () => {
    const chunks = [];
    const writable = new WritableStream({ write(c) { chunks.push(c); } });

    const logs = [];
    const result = await streamDownloadAndDecrypt(
      'http://mock/file', 'a'.repeat(64), 'out.bin',
      { writable, log: (m) => logs.push(m) }
    );

    expect(result).toEqual({ ok: true });
    expect(logs.some(m => m.includes('Download complete'))).toBe(true);
    expect(chunks.length).toBe(1);
    expect(new TextDecoder().decode(chunks[0])).toBe('hello from mock');
  });

  test('throws when no writable and no StreamSaver', async () => {
    const logs = [];
    await expect(
      streamDownloadAndDecrypt('http://mock/file', 'a'.repeat(64), 'out.bin', { log: (m) => logs.push(m) })
    ).rejects.toThrow('No streaming writable');
    expect(logs.some(m => m.includes('failed'))).toBe(true);
  }, 15000);
});

/**
 * downloadUnsealed callback orchestration tests.
 *
 * Uses synthetic HTTP responses for inspectSealed and mocked download impls
 * to verify onLog / onDownloadReady / onProgress / onSuccess / onError wiring.
 *
 * Run alone:
 *   node --experimental-vm-modules node_modules/.bin/jest --config jest.config.browser.mjs test/downloadUnsealedCallbacks.spec.mjs
 */

import { jest } from '@jest/globals';
import { webcrypto as nodeWebcrypto } from 'crypto';
import { HeaderSize } from '../src/common/limits.js';

globalThis.crypto = nodeWebcrypto;

jest.unstable_mockModule('../src/browser/stream_download.js', () => ({
  streamDownloadAndDecrypt: jest.fn(async (_url, _key, _filename, opts) => {
    opts?.log?.('Stream download starting...');
    opts?.onDownloadReady?.();
    opts?.onProgress?.(100, 50, 50, 50);
    opts?.onByteProgress?.(1000, 500);
    opts?.log?.('Download complete');
  }),
}));

jest.unstable_mockModule('../src/browser/blob_download.js', () => ({
  blobDownloadAndDecrypt: jest.fn(async (_url, _key, _filename, opts) => {
    opts?.log?.('Using Blob download...');
    opts?.onDownloadReady?.();
    opts?.onProgress?.(100, 50, 50, 50);
    opts?.onByteProgress?.(1000, 500);
    opts?.log?.('Download complete (client-side Blob decrypt)');
  }),
}));

const { downloadUnsealed, inspectSealed } = await import('../src/browser/downloadUnsealed.js');
const { streamDownloadAndDecrypt } = await import('../src/browser/stream_download.js');
const { blobDownloadAndDecrypt } = await import('../src/browser/blob_download.js');

/** Disk-layout sealed buffer: [content][64-byte header at tail] */
function makeInspectDiskBuf(contentBytes = 200) {
  const header = Buffer.alloc(HeaderSize);
  Buffer.from('1fe2ef7f3ed18847', 'hex').copy(header, 0);
  header.writeUInt32LE(2, 8);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(1, 24);
  return Buffer.concat([Buffer.alloc(contentBytes, 0xab), header]);
}

function createMockFetch(diskBuf) {
  const totalSize = diskBuf.length;
  return async function mockFetch(_url, init = {}) {
    if (init.method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        headers: { get: (n) => (n.toLowerCase() === 'content-length' ? String(totalSize) : null) },
      };
    }
    const m = /bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || '');
    if (m) {
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      const sliced = new Uint8Array(diskBuf.slice(start, Math.min(end + 1, totalSize)));
      return {
        ok: true,
        status: 206,
        headers: { get: (n) => n.toLowerCase() === 'content-range'
          ? `bytes ${start}-${end}/${totalSize}`
          : null },
        arrayBuffer: async () => sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength),
      };
    }
    return { ok: false, status: 404 };
  };
}

describe('downloadUnsealed callback orchestration', () => {
  const privateKeyHex = 'a'.repeat(64);
  let origFetch;
  let origUA;

  beforeEach(() => {
    jest.clearAllMocks();
    origFetch = globalThis.fetch;
    origUA = navigator.userAgent;
    globalThis.fetch = createMockFetch(makeInspectDiskBuf());
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true });
  });

  test('desktop path forwards callbacks and calls onSuccess after stream download', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });

    const events = [];
    await downloadUnsealed({
      url: 'http://fixture/sealed.file',
      privateKey: privateKeyHex,
      filename: 'out.bin',
      onLog: (msg) => events.push(['log', msg]),
      onDownloadReady: () => events.push('ready'),
      onProgress: (...args) => events.push(['progress', ...args]),
      onSuccess: (data) => events.push(['success', data]),
    });

    expect(streamDownloadAndDecrypt).toHaveBeenCalledTimes(1);
    expect(blobDownloadAndDecrypt).not.toHaveBeenCalled();
    expect(events.filter((e) => e === 'ready')).toHaveLength(1);
    expect(events.some((e) => Array.isArray(e) && e[0] === 'progress')).toBe(true);
    expect(events.some((e) => Array.isArray(e) && e[0] === 'success' && e[1]?.filename === 'out.bin')).toBe(true);
    const readyIdx = events.indexOf('ready');
    const successIdx = events.findIndex((e) => Array.isArray(e) && e[0] === 'success');
    expect(successIdx).toBeGreaterThan(readyIdx);
  });

  test('mobile path forwards callbacks and calls onSuccess after blob download', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      configurable: true,
    });

    const events = [];
    await downloadUnsealed({
      url: 'http://fixture/sealed.file',
      privateKey: privateKeyHex,
      filename: 'out.bin',
      onDownloadReady: () => events.push('ready'),
      onProgress: (...args) => events.push(['progress', ...args]),
      onSuccess: (data) => events.push(['success', data]),
    });

    expect(blobDownloadAndDecrypt).toHaveBeenCalledTimes(1);
    expect(streamDownloadAndDecrypt).not.toHaveBeenCalled();
    expect(events.filter((e) => e === 'ready')).toHaveLength(1);
    expect(events.some((e) => Array.isArray(e) && e[0] === 'success')).toBe(true);
  });

  test('calls onError when inspect fails', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };

    const errors = [];
    await downloadUnsealed({
      url: 'http://fixture/bad',
      privateKey: privateKeyHex,
      filename: 'out.bin',
      onError: (err) => errors.push(err),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/network down|HEAD/i);
  });

  test('inspectSealed defaults to a no-op logger', async () => {
    await expect(inspectSealed('http://fixture/sealed.file')).resolves.toMatchObject({ itemNumber: 1 });
  });

  test('inspectSealed accepts a 206 when cross-origin Content-Range is not exposed', async () => {
    const diskBuf = makeInspectDiskBuf();
    const baseFetch = createMockFetch(diskBuf);
    globalThis.fetch = async (url, init = {}) => {
      const response = await baseFetch(url, init);
      if (init.method !== 'HEAD') response.headers = { get: () => null };
      return response;
    };

    await expect(inspectSealed('https://files.example.test/sealed.file'))
      .resolves.toMatchObject({ itemNumber: 1, totalSize: diskBuf.length });
  });

  test('keeps item and byte progress callbacks on separate signatures', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Desktop', configurable: true });
    const itemCalls = [];
    const byteCalls = [];
    await downloadUnsealed({
      url: 'http://fixture/sealed.file',
      privateKey: privateKeyHex,
      filename: 'out.bin',
      onProgress: (...args) => itemCalls.push(args),
      onByteProgress: (...args) => byteCalls.push(args),
    });
    expect(itemCalls).toEqual([[100, 50, 50, 50]]);
    expect(byteCalls).toEqual([[1000, 500]]);
  });

  test('does not retry with Blob after an operational stream failure', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Desktop', configurable: true });
    streamDownloadAndDecrypt.mockRejectedValueOnce(new Error('wrong key'));
    const errors = [];
    await downloadUnsealed({
      url: 'http://fixture/sealed.file',
      privateKey: privateKeyHex,
      filename: 'out.bin',
      onError: (error) => errors.push(error),
    });
    expect(errors[0]?.message).toBe('wrong key');
    expect(blobDownloadAndDecrypt).not.toHaveBeenCalled();
  });

  test('falls back only when no stream writable is available', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Desktop', configurable: true });
    const unavailable = new Error('unavailable');
    unavailable.code = 'ERR_NO_STREAM_WRITABLE';
    streamDownloadAndDecrypt.mockRejectedValueOnce(unavailable);
    await downloadUnsealed({
      url: 'http://fixture/sealed.file',
      privateKey: privateKeyHex,
      filename: 'out.bin',
    });
    expect(blobDownloadAndDecrypt).toHaveBeenCalledTimes(1);
  });

  test('missing parameters are reported through onError', async () => {
    const errors = [];
    await downloadUnsealed({ filename: 'x', onError: (error) => errors.push(error) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'ERR_MISSING_PARAMS' });
  });
});

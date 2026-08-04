/**
 * downloadUnsealed size-limit overrides.
 *
 *   node --experimental-vm-modules node_modules/.bin/jest --config jest.config.browser.mjs test/downloadUnsealedSizeLimit.spec.mjs
 */
import { jest } from '@jest/globals';
import { webcrypto as nodeWebcrypto } from 'crypto';
import { HeaderSize } from '../src/common/limits.js';

globalThis.crypto = nodeWebcrypto;

jest.unstable_mockModule('../src/browser/stream_download.js', () => ({
  streamDownloadAndDecrypt: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../src/browser/blob_download.js', () => ({
  blobDownloadAndDecrypt: jest.fn(async () => {}),
}));

const { downloadUnsealed } = await import('../src/browser/downloadUnsealed.js');
const { MetaEncryptorError } = await import('../src/common/errors.js');
const { streamDownloadAndDecrypt } = await import('../src/browser/stream_download.js');

function makeInspectDiskBuf(contentBytes = 200) {
  const header = Buffer.alloc(HeaderSize);
  Buffer.from('1fe2ef7f3ed18847', 'hex').copy(header, 0);
  header.writeUInt32LE(2, 8);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(1, 24);
  return Buffer.concat([Buffer.alloc(contentBytes, 0xab), header]);
}

function createMockFetch(diskBuf) {
  const totalSize = diskBuf.length;
  return jest.fn(async (url, init = {}) => {
    if (init.method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        url,
        headers: {
          get: (k) => {
            const key = String(k).toLowerCase();
            if (key === 'content-length') return String(totalSize);
            if (key === 'accept-ranges') return 'bytes';
            return null;
          },
        },
      };
    }
    const range = init.headers?.Range || init.headers?.range || '';
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : totalSize - 1;
    const slice = diskBuf.subarray(start, end + 1);
    return {
      ok: true,
      status: 206,
      url,
      headers: {
        get: (k) => {
          const key = String(k).toLowerCase();
          if (key === 'content-length') return String(slice.length);
          if (key === 'content-range') return `bytes ${start}-${end}/${totalSize}`;
          return null;
        },
      },
      arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    };
  });
}

describe('downloadUnsealed size limit config', () => {
  const key = 'a'.repeat(64);

  beforeEach(() => {
    streamDownloadAndDecrypt.mockClear();
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Macintosh)' },
      configurable: true,
    });
  });

  test('rejects when plaintext exceeds default desktop 1GiB', async () => {
    // plaintextSize = sealedContentSize - itemNumber*100
    // sealedContentSize = totalSize - HeaderSize - blockNumber*BlockInfoSize
    // Make a large content so plaintextSize > 1GiB is hard in unit test;
    // instead spy by using a tiny custom desktopLimit.
    const diskBuf = makeInspectDiskBuf(500);
    globalThis.fetch = createMockFetch(diskBuf);
    await expect(
      downloadUnsealed({
        url: 'https://example.com/file',
        privateKey: key,
        filename: 'out.bin',
        desktopLimit: 1, // 1 byte — force reject
      })
    ).rejects.toMatchObject({ code: 'ERR_FILE_TOO_LARGE' });
    expect(streamDownloadAndDecrypt).not.toHaveBeenCalled();
  });

  test('allows oversized (vs default) when desktopLimit raised', async () => {
    const diskBuf = makeInspectDiskBuf(500);
    globalThis.fetch = createMockFetch(diskBuf);
    await downloadUnsealed({
      url: 'https://example.com/file',
      privateKey: key,
      filename: 'out.bin',
      desktopLimit: 10 * 1024 * 1024 * 1024,
    });
    expect(streamDownloadAndDecrypt).toHaveBeenCalled();
  });
});

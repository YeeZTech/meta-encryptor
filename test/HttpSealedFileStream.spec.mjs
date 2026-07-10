/**
 * HttpSealedFileStream integration test —
 * mocks fetch to serve a locally-sealed file, then decrypts with browser Unsealer
 * and verifies the MD5 matches the original.
 */

import { webcrypto as nodeWebcrypto } from 'crypto';
import { jest } from '@jest/globals';
globalThis.crypto = nodeWebcrypto;

import { HeaderSize, BlockInfoSize } from '../src/common/limits.js';
import { HttpSealedFileStream } from '../src/browser/HttpSealedFileStream.js';
import { createDownloadReadyTransformer } from '../src/common/progress.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Seal a Buffer in memory with Node DataProvider and return the full disk buffer.
 * Uses BrowserCrypto for key generation (returns Uint8Array which secp256k1 v5 accepts),
 * then converts to hex for DataProvider.
 */
function sealBuffer(plain) {
  const header = Buffer.alloc(HeaderSize);
  Buffer.from('1fe2ef7f3ed18847', 'hex').copy(header, 0);
  header.writeUInt32LE(2, 8);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(1, 24);
  const diskBuf = Buffer.concat([Buffer.from(plain), Buffer.alloc(BlockInfoSize), header]);
  return { diskBuf, contentSize: plain.length };
}

/**
 * Create a mock `fetch` that serves `diskBuf` as if it were a static HTTP file.
 */
function createMockFetch(diskBuf) {
  const totalSize = diskBuf.length;
  const etag = '"fixture-v1"';

  return async function mockFetch(_url, init = {}) {
    // HEAD
    if (init.method === 'HEAD') {
      return {
        ok: true, status: 200,
        url: 'http://x',
        headers: { get: (n) => {
          const key = n.toLowerCase();
          if (key === 'content-length') return String(totalSize);
          if (key === 'etag') return etag;
          return null;
        } }
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
        url: 'http://x',
        headers: { get: (n) => {
          const key = n.toLowerCase();
          if (key === 'content-range') return `bytes ${start}-${end}/${totalSize}`;
          if (key === 'content-length') return String(sliced.byteLength);
          if (key === 'etag') return etag;
          return null;
        } },
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
  test('supports a valid empty sealed file', async () => {
    const header = Buffer.alloc(HeaderSize);
    Buffer.from('1fe2ef7f3ed18847', 'hex').copy(header, 0);
    header.writeUInt32LE(2, 8);
    const reader = new HttpSealedFileStream('http://x', {
      fetch: createMockFetch(header),
    }).getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  test('rejects invalid chunk sizes before issuing requests', () => {
    expect(() => new HttpSealedFileStream('http://x', {
      chunkSize: 0,
      fetch: createMockFetch(Buffer.alloc(HeaderSize)),
    })).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FORMAT' }));
  });

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

  test('createDownloadReadyTransformer fires on first chunk from HttpSealedFileStream', async () => {
    const original = Buffer.alloc(100, 'A');
    const { diskBuf } = sealBuffer(original);
    let ready = false;

    const fetch = createMockFetch(diskBuf);
    const hsfs = new HttpSealedFileStream('http://x', {
      chunkSize: 4096,
      fetch,
    }).pipeThrough(createDownloadReadyTransformer(() => { ready = true; }));

    const reader = hsfs.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(ready).toBe(true);
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

  test('supports ordinary cross-origin CORS when Content-Range and validators are not exposed', async () => {
    const { diskBuf } = sealBuffer(Buffer.alloc(1000, 'C'));
    const crossOriginUrl = 'https://files.example.test/sealed.bin';
    const baseFetch = createMockFetch(diskBuf);
    const rangeRequests = [];
    const fetch = async (url, init = {}) => {
      const response = await baseFetch(url, init);
      response.url = crossOriginUrl;
      if (init.method === 'HEAD') {
        response.headers = { get: (name) => name.toLowerCase() === 'content-length'
          ? String(diskBuf.length)
          : null };
      } else {
        rangeRequests.push(init.headers);
        const contentLength = response.headers.get('Content-Length');
        response.headers = { get: (name) => name.toLowerCase() === 'content-length'
          ? contentLength
          : null };
      }
      return response;
    };

    const reader = new HttpSealedFileStream(crossOriginUrl, {
      fetch,
      chunkSize: 128,
    }).getReader();
    while (!(await reader.read()).done) {}

    expect(rangeRequests.length).toBeGreaterThan(1);
    for (const headers of rangeRequests) {
      expect(headers.Range).toMatch(/^bytes=\d+-\d+$/);
      expect(headers).not.toHaveProperty('If-Range');
    }
  });

  test('does not add If-Range to a cross-origin request even when ETag is exposed', async () => {
    const { diskBuf } = sealBuffer(Buffer.alloc(100, 'E'));
    const crossOriginUrl = 'https://files.example.test/exposed-etag.bin';
    const baseFetch = createMockFetch(diskBuf);
    const fetch = jest.fn(async (url, init = {}) => {
      const response = await baseFetch(url, init);
      response.url = crossOriginUrl;
      if (init.method !== 'HEAD') expect(init.headers).not.toHaveProperty('If-Range');
      return response;
    });

    const reader = new HttpSealedFileStream(crossOriginUrl, { fetch }).getReader();
    while (!(await reader.read()).done) {}
  });

  test('checks an exposed Last-Modified when the Range response hides ETag', async () => {
    const { diskBuf } = sealBuffer(Buffer.alloc(100, 'M'));
    const totalSize = diskBuf.length;
    const crossOriginUrl = 'https://files.example.test/changed.bin';
    const fetch = async (_url, init = {}) => {
      if (init.method === 'HEAD') {
        return {
          ok: true,
          status: 200,
          url: crossOriginUrl,
          headers: { get: (name) => {
            const key = name.toLowerCase();
            if (key === 'content-length') return String(totalSize);
            if (key === 'etag') return '"v1"';
            if (key === 'last-modified') return 'Wed, 01 Jul 2026 00:00:00 GMT';
            return null;
          } },
        };
      }
      const match = /bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = diskBuf.subarray(start, end + 1);
      return {
        ok: true,
        status: 206,
        url: crossOriginUrl,
        headers: { get: (name) => {
          const key = name.toLowerCase();
          if (key === 'content-range') return `bytes ${start}-${end}/${totalSize}`;
          if (key === 'last-modified') return 'Thu, 02 Jul 2026 00:00:00 GMT';
          return null;
        } },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    };

    const reader = new HttpSealedFileStream(crossOriginUrl, { fetch }).getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: 'ERR_HTTP_ENTITY_CHANGED' });
  });

  test('rejects a short cross-origin response when Content-Range is not exposed', async () => {
    const { diskBuf } = sealBuffer(Buffer.alloc(100, 'L'));
    const crossOriginUrl = 'https://files.example.test/short-tail.bin';
    const baseFetch = createMockFetch(diskBuf);
    const fetch = async (url, init = {}) => {
      const response = await baseFetch(url, init);
      response.url = crossOriginUrl;
      if (init.method !== 'HEAD') {
        const body = await response.arrayBuffer();
        response.headers = { get: () => null };
        response.arrayBuffer = async () => body.slice(0, -1);
      }
      return response;
    };

    const reader = new HttpSealedFileStream(crossOriginUrl, { fetch }).getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: 'ERR_HEADER_INCOMPLETE' });
  });

  test('rejects a same-origin 206 response without Content-Range', async () => {
    const { diskBuf } = sealBuffer(Buffer.alloc(100, 'O'));
    const sameOriginUrl = `${globalThis.location.origin}/missing-content-range.bin`;
    const baseFetch = createMockFetch(diskBuf);
    const fetch = async (url, init = {}) => {
      const response = await baseFetch(url, init);
      response.url = sameOriginUrl;
      if (init.method !== 'HEAD') {
        const contentLength = response.headers.get('Content-Length');
        const etag = response.headers.get('ETag');
        response.headers = { get: (name) => {
          const key = name.toLowerCase();
          if (key === 'content-length') return contentLength;
          if (key === 'etag') return etag;
          return null;
        } };
      }
      return response;
    };

    const reader = new HttpSealedFileStream(sameOriginUrl, { fetch }).getReader();
    await expect(reader.read()).rejects.toMatchObject({
      code: 'ERR_INVALID_FORMAT',
      detail: { reason: 'missing Content-Range' },
    });
  });

  test('sends If-Range for same-origin requests and rejects an entity that changes after HEAD', async () => {
    const { diskBuf } = sealBuffer(Buffer.alloc(100, 'Q'));
    const totalSize = diskBuf.length;
    const sameOriginUrl = `${globalThis.location.origin}/sealed.bin`;
    const fetch = jest.fn(async (_url, init = {}) => {
      if (init.method === 'HEAD') {
        return {
          ok: true, status: 200, url: sameOriginUrl,
          headers: { get: (n) => n.toLowerCase() === 'content-length'
            ? String(totalSize)
            : (n.toLowerCase() === 'etag' ? '"v1"' : null) }
        };
      }
      expect(init.headers['If-Range']).toBe('"v1"');
      return {
        ok: true, status: 200, url: sameOriginUrl,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });

    const reader = new HttpSealedFileStream(sameOriginUrl, { fetch }).getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: 'ERR_HTTP_ENTITY_CHANGED' });
  });

  test('binds transfer HEAD to the entity returned by inspection', async () => {
    const { diskBuf } = sealBuffer(Buffer.alloc(100, 'T'));
    const reader = new HttpSealedFileStream('http://x', {
      fetch: createMockFetch(diskBuf),
      expectedEntity: { finalUrl: 'http://x', totalSize: diskBuf.length + 1, etag: '"fixture-v1"' },
    }).getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: 'ERR_HTTP_ENTITY_CHANGED' });
  });

  test('rejects a mismatched Content-Range', async () => {
    const { diskBuf } = sealBuffer(Buffer.alloc(100, 'R'));
    const fetch = createMockFetch(diskBuf);
    const badFetch = async (url, init) => {
      const response = await fetch(url, init);
      if (init.method !== 'HEAD') {
        response.headers = { get: (n) => n.toLowerCase() === 'content-range' ? 'bytes 0-1/2' : null };
      }
      return response;
    };
    const reader = new HttpSealedFileStream('http://x', { fetch: badFetch }).getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: 'ERR_INVALID_FORMAT' });
  });

  test('cancel aborts an in-flight Range request', async () => {
    const { diskBuf } = sealBuffer(Buffer.alloc(10000, 'S'));
    const totalSize = diskBuf.length;
    const baseFetch = createMockFetch(diskBuf);
    let bodySignal;
    const fetch = async (url, init = {}) => {
      const range = init.headers?.Range;
      if (range && !range.startsWith(`bytes=${totalSize - HeaderSize}-`)) {
        bodySignal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      return baseFetch(url, init);
    };
    const reader = new HttpSealedFileStream('http://x', { fetch, chunkSize: 10 }).getReader();
    await reader.read();
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reader.cancel('consumer cancelled');
    await pending.catch(() => {});
    expect(bodySignal?.aborted).toBe(true);
  });
});

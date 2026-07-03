/**
 * HttpSealedFileStream — a ReadableStream that fetches a sealed file from a URL
 * and streams its raw content (header + data, skipping block-info bytes).
 *
 * Analogous to Node's SealedFileStream but works over HTTP with Range requests.
 * Pull-based: one Range request per pull(), so downstream backpressure limits
 * how much data is buffered (the old implementation fetched the whole file
 * inside start(), buffering it unboundedly when the consumer was slow or
 * never ready).
 *
 * Usage:
 *   const stream = new HttpSealedFileStream('https://example.com/file.sealed');
 *   stream.pipeThrough(new Unsealer({ privateKeyHex: '…' }))
 *         .pipeTo(new WritableStream({ write(chunk) { … } }));
 */

import { HeaderSize, BlockInfoSize } from '../common/limits.js';
import { validateHeader } from '../common/unsealer_core.js';
import { MetaEncryptorError } from '../common/errors.js';
import { fetchRange, resolvedFetchUrl } from './fetchRange.js';

const DEFAULT_CHUNK = 1024 * 1024; // 1 MB per Range request

export class HttpSealedFileStream extends ReadableStream {
  /**
   * @param {string} url - URL of the sealed file (must support HEAD + Range)
   * @param {object} [options]
   * @param {number} [options.chunkSize] - bytes per Range request (default 1 MB)
   * @param {Function} [options.fetch] - fetch impl (defaults to globalThis.fetch)
   * @param {AbortSignal} [options.signal] - aborts in-flight requests
   */
  constructor(url, { chunkSize = DEFAULT_CHUNK, fetch: fetchFn, signal } = {}) {
    const _fetch = fetchFn || fetch.bind(globalThis);
    const state = {
      url,
      fetchUrl: url,
      totalSize: 0,
      blockNumber: 0,
      contentSize: 0,
      pos: 0,
    };

    const CHUNK = chunkSize;

    super({
      start: async (controller) => {
        try {
          let headResp;
          try {
            headResp = await _fetch(url, { method: 'HEAD', signal });
          } catch (e) {
            throw new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', { detail: { status: e.message }, cause: e });
          }
          if (!headResp.ok) {
            throw new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', { detail: { status: headResp.status } });
          }
          const totalSize = parseInt(headResp.headers.get('Content-Length') || '0', 10);
          if (totalSize < HeaderSize) {
            throw new MetaEncryptorError('ERR_FILE_TOO_SMALL');
          }
          state.totalSize = totalSize;
          state.fetchUrl = resolvedFetchUrl(headResp, url);

          const tailStart = totalSize - HeaderSize;
          const { response: tailResp } = await fetchRange(state.fetchUrl, {
            start: tailStart, end: totalSize - 1, fetch: _fetch, signal
          });
          const headerBuf = new Uint8Array(await tailResp.arrayBuffer());
          if (headerBuf.length !== HeaderSize) {
            throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE', {
              detail: { expected: HeaderSize, actual: headerBuf.length }
            });
          }

          const { blockNumber } = validateHeader(headerBuf);
          state.blockNumber = blockNumber;

          state.contentSize = totalSize - HeaderSize - BlockInfoSize * state.blockNumber;
          if (state.contentSize <= 0) {
            throw new MetaEncryptorError('ERR_EMPTY_CONTENT');
          }

          controller.enqueue(headerBuf);
        } catch (e) {
          controller.error(e);
        }
      },

      pull: async (controller) => {
        try {
          if (state.pos >= state.contentSize) {
            controller.close();
            return;
          }
          const chunkEnd = Math.min(state.pos + CHUNK, state.contentSize);
          const { response: resp } = await fetchRange(state.fetchUrl, {
            start: state.pos, end: chunkEnd - 1, fetch: _fetch, signal
          });
          const buf = new Uint8Array(await resp.arrayBuffer());
          const expected = chunkEnd - state.pos;
          if (buf.length !== expected) {
            throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', {
              detail: { expected, actual: buf.length, pos: state.pos }
            });
          }
          controller.enqueue(buf);
          state.pos = chunkEnd;
        } catch (e) {
          controller.error(e);
        }
      }
    });

    // expose live state (start() is async, so plain copies would stay 0)
    this.url = url;
    Object.defineProperties(this, {
      totalSize: { get: () => state.totalSize },
      blockNumber: { get: () => state.blockNumber },
      contentSize: { get: () => state.contentSize },
    });
  }
}

export default HttpSealedFileStream;

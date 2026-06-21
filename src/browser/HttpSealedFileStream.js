/**
 * HttpSealedFileStream — a ReadableStream that fetches a sealed file from a URL
 * and streams its raw content (header + data, skipping block-info bytes).
 *
 * Analogous to Node's SealedFileStream but works over HTTP with Range requests.
 *
 * Usage:
 *   const stream = new HttpSealedFileStream('https://example.com/file.sealed');
 *   stream.pipeThrough(new Unsealer({ privateKeyHex: '…' }))
 *         .pipeTo(new WritableStream({ write(chunk) { … } }));
 */

import { HeaderSize, BlockInfoSize } from '../common/limits.js';
import { validateHeader } from '../common/unsealer_core.js';
import { MetaEncryptorError } from '../common/errors.js';

const DEFAULT_CHUNK = 1024 * 1024; // 1 MB per Range request

export class HttpSealedFileStream extends ReadableStream {
  /**
   * @param {string} url - URL of the sealed file (must support HEAD + Range)
   * @param {object} [options]
   * @param {number} [options.chunkSize] - bytes per Range request (default 1 MB)
   * @param {Function} [options.fetch] - fetch impl (defaults to globalThis.fetch)
   */
  constructor(url, { chunkSize = DEFAULT_CHUNK, fetch: fetchFn } = {}) {
    const _fetch = fetchFn || fetch.bind(globalThis);
    const state = {
      url,
      totalSize: 0,
      blockNumber: 0,
      contentSize: 0,
    };

    const CHUNK = chunkSize;

    super({
      start: async (controller) => {
        let headResp;
        try {
          headResp = await _fetch(url, { method: 'HEAD' });
        } catch (e) {
          controller.error(new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', { detail: { status: e.message }, cause: e }));
          return;
        }
        if (!headResp.ok) {
          controller.error(new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', { detail: { status: headResp.status } }));
          return;
        }
        const totalSize = parseInt(headResp.headers.get('Content-Length') || '0', 10);
        if (totalSize < HeaderSize) {
          controller.error(new MetaEncryptorError('ERR_FILE_TOO_SMALL'));
          return;
        }
        state.totalSize = totalSize;

        const tailStart = totalSize - HeaderSize;
        let tailResp;
        try {
          tailResp = await _fetch(url, {
            headers: { Range: `bytes=${tailStart}-${totalSize - 1}` }
          });
        } catch (e) {
          controller.error(new MetaEncryptorError('ERR_CANNOT_READ_TAIL', { detail: { status: e.message }, cause: e }));
          return;
        }
        if (!tailResp.ok) {
          controller.error(new MetaEncryptorError('ERR_CANNOT_READ_TAIL', { detail: { status: tailResp.status } }));
          return;
        }
        const headerBuf = new Uint8Array(await tailResp.arrayBuffer());
        if (headerBuf.length !== HeaderSize) {
          controller.error(new MetaEncryptorError('ERR_HEADER_INCOMPLETE', { detail: { expected: HeaderSize, actual: headerBuf.length } }));
          return;
        }

        const dv = new DataView(headerBuf.buffer, headerBuf.byteOffset, headerBuf.byteLength);
        const lo = dv.getUint32(16, true);
        const hi = dv.getUint32(20, true);
        state.blockNumber = hi * 0x100000000 + lo;

        controller.enqueue(headerBuf);

        state.contentSize = totalSize - HeaderSize - BlockInfoSize * state.blockNumber;
        if (state.contentSize <= 0) {
          controller.error(new MetaEncryptorError('ERR_EMPTY_CONTENT'));
          return;
        }

        let pos = 0;
        while (pos < state.contentSize) {
          const chunkEnd = Math.min(pos + CHUNK, state.contentSize);
          let resp;
          try {
            resp = await _fetch(url, {
              headers: { Range: `bytes=${pos}-${chunkEnd - 1}` }
            });
          } catch (e) {
            controller.error(new MetaEncryptorError('ERR_CANNOT_READ_TAIL', { detail: { pos, message: e.message }, cause: e }));
            return;
          }
          if (!resp.ok) {
            controller.error(new MetaEncryptorError('ERR_CANNOT_READ_TAIL', { detail: { pos, status: resp.status } }));
            return;
          }
          const buf = new Uint8Array(await resp.arrayBuffer());
          if (buf.length > 0) {
            controller.enqueue(buf);
          }
          pos = chunkEnd;
        }

        controller.close();
      }
    });

    // expose state via public getters
    this.url = url;
    this.totalSize = state.totalSize;
    this.blockNumber = state.blockNumber;
    this.contentSize = state.contentSize;
  }
}

export default HttpSealedFileStream;

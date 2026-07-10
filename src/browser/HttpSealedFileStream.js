import { HeaderSize, BlockInfoSize } from '../common/limits.js';
import { validateHeader } from '../common/unsealer_core.js';
import { MetaEncryptorError } from '../common/errors.js';
import { fetchRange, resolvedFetchUrl } from './fetchRange.js';

const DEFAULT_CHUNK = 1024 * 1024;

function parseContentLength(response) {
  const raw = response.headers.get('Content-Length');
  if (!/^\d+$/.test(raw || '')) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { reason: 'missing or invalid Content-Length', value: raw }
    });
  }
  const size = Number(raw);
  if (!Number.isSafeInteger(size)) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { reason: 'unsafe Content-Length', value: raw }
    });
  }
  return size;
}

function linkAbortSignal(source, controller) {
  if (!source) return () => {};
  const abort = () => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

/** A pull-based sealed-content stream backed by strict HTTP Range requests. */
export class HttpSealedFileStream extends ReadableStream {
  constructor(url, { chunkSize = DEFAULT_CHUNK, fetch: fetchFn, signal, expectedEntity } = {}) {
    if (typeof url !== 'string' || url.length === 0) {
      throw new MetaEncryptorError('ERR_MISSING_PARAMS', { detail: { url: 'empty' } });
    }
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
        detail: { reason: 'invalid chunkSize', chunkSize }
      });
    }
    const _fetch = fetchFn || globalThis.fetch;
    if (typeof _fetch !== 'function') throw new MetaEncryptorError('ERR_FETCH_UNAVAILABLE');

    const abortController = new AbortController();
    const unlinkAbort = linkAbortSignal(signal, abortController);
    const state = {
      fetchUrl: url,
      totalSize: 0,
      blockNumber: 0,
      itemNumber: 0,
      contentSize: 0,
      pos: 0,
      etag: null,
      lastModified: null,
      closed: false,
    };
    const rangeOptions = () => ({
      fetch: _fetch,
      signal: abortController.signal,
      expectedUrl: state.fetchUrl,
      etag: state.etag,
      lastModified: state.lastModified,
      totalSize: state.totalSize,
    });

    super({
      start: async (controller) => {
        try {
          let headResp;
          try {
            headResp = await _fetch(url, {
              method: 'HEAD',
              cache: 'no-store',
              redirect: 'follow',
              signal: abortController.signal,
            });
          } catch (cause) {
            if (abortController.signal.aborted) throw abortController.signal.reason || cause;
            throw new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', {
              detail: { status: cause?.message }, cause
            });
          }
          if (!headResp.ok) {
            throw new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', {
              detail: { status: headResp.status }
            });
          }
          state.fetchUrl = resolvedFetchUrl(headResp, url);
          state.totalSize = parseContentLength(headResp);
          state.etag = headResp.headers.get('ETag');
          state.lastModified = headResp.headers.get('Last-Modified');
          if (expectedEntity) {
            if (expectedEntity.finalUrl && state.fetchUrl !== expectedEntity.finalUrl) {
              throw new MetaEncryptorError('ERR_HTTP_ENTITY_CHANGED', {
                detail: { reason: 'final URL changed after inspection' }
              });
            }
            if (expectedEntity.totalSize !== undefined && state.totalSize !== expectedEntity.totalSize) {
              throw new MetaEncryptorError('ERR_HTTP_ENTITY_CHANGED', {
                detail: {
                  reason: 'entity size changed after inspection',
                  expectedSize: expectedEntity.totalSize,
                  actualSize: state.totalSize,
                }
              });
            }
            if (expectedEntity.etag && state.etag !== expectedEntity.etag) {
              throw new MetaEncryptorError('ERR_HTTP_ENTITY_CHANGED', {
                detail: { reason: 'ETag changed after inspection' }
              });
            }
            if (!expectedEntity.etag && expectedEntity.lastModified &&
                state.lastModified !== expectedEntity.lastModified) {
              throw new MetaEncryptorError('ERR_HTTP_ENTITY_CHANGED', {
                detail: { reason: 'Last-Modified changed after inspection' }
              });
            }
          }
          if (state.totalSize < HeaderSize) throw new MetaEncryptorError('ERR_FILE_TOO_SMALL');

          const tailStart = state.totalSize - HeaderSize;
          const { response } = await fetchRange(state.fetchUrl, {
            start: tailStart,
            end: state.totalSize - 1,
            ...rangeOptions(),
          });
          const headerBuf = new Uint8Array(await response.arrayBuffer());
          if (headerBuf.length !== HeaderSize) {
            throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE', {
              detail: { expected: HeaderSize, actual: headerBuf.length }
            });
          }

          const { blockNumber, itemNumber } = validateHeader(headerBuf);
          state.blockNumber = blockNumber;
          state.itemNumber = itemNumber;
          state.contentSize = state.totalSize - HeaderSize - BlockInfoSize * blockNumber;
          if (!Number.isSafeInteger(state.contentSize) || state.contentSize < 0) {
            throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
              detail: { reason: 'block metadata exceeds file size' }
            });
          }
          if (state.contentSize === 0 && (blockNumber !== 0 || itemNumber !== 0)) {
            throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
              detail: { reason: 'non-empty header describes empty content', blockNumber, itemNumber }
            });
          }
          if (state.contentSize > 0 && itemNumber === 0) {
            throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
              detail: { reason: 'zero items with trailing sealed content', contentSize: state.contentSize }
            });
          }
          controller.enqueue(headerBuf);
        } catch (error) {
          unlinkAbort();
          state.closed = true;
          abortController.abort(error);
          controller.error(error);
        }
      },

      pull: async (controller) => {
        try {
          if (state.pos >= state.contentSize) {
            state.closed = true;
            unlinkAbort();
            controller.close();
            return;
          }
          const chunkEnd = Math.min(state.pos + chunkSize, state.contentSize);
          const { response } = await fetchRange(state.fetchUrl, {
            start: state.pos,
            end: chunkEnd - 1,
            ...rangeOptions(),
          });
          const buf = new Uint8Array(await response.arrayBuffer());
          const expected = chunkEnd - state.pos;
          if (buf.length !== expected) {
            throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', {
              detail: { expected, actual: buf.length, pos: state.pos }
            });
          }
          state.pos = chunkEnd;
          controller.enqueue(buf);
        } catch (error) {
          unlinkAbort();
          state.closed = true;
          abortController.abort(error);
          controller.error(error);
        }
      },

      cancel: (reason) => {
        state.closed = true;
        unlinkAbort();
        abortController.abort(reason);
      },
    });

    this.url = url;
    Object.defineProperties(this, {
      totalSize: { get: () => state.totalSize },
      blockNumber: { get: () => state.blockNumber },
      itemNumber: { get: () => state.itemNumber },
      contentSize: { get: () => state.contentSize },
      finalUrl: { get: () => state.fetchUrl },
    });
  }
}

export default HttpSealedFileStream;

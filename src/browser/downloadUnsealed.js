import { HeaderSize, BlockInfoSize } from '../common/limits.js';
import { validateHeader } from '../common/unsealer_core.js';
import { MetaEncryptorError } from '../common/errors.js';
import { blobDownloadAndDecrypt } from './blob_download.js';
import { streamDownloadAndDecrypt } from './stream_download.js';
import { fetchRange, resolvedFetchUrl } from './fetchRange.js';

const MOBILE_LIMIT = 200 * 1024 * 1024;
const DESKTOP_LIMIT = 1024 * 1024 * 1024;
const noop = () => {};

function isMobile() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
}

function makeLogger(onLog) {
  return onLog ? (msg) => onLog(String(msg)) : noop;
}

function exactContentLength(response) {
  const raw = response.headers.get('Content-Length');
  if (!/^\d+$/.test(raw || '')) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { reason: 'missing or invalid Content-Length', value: raw }
    });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { reason: 'unsafe Content-Length', value: raw }
    });
  }
  return value;
}

export async function inspectSealed(url, log = noop, { fetch: fetchFn, signal } = {}) {
  log = typeof log === 'function' ? log : noop;
  const _fetch = fetchFn || globalThis.fetch;
  if (typeof _fetch !== 'function') throw new MetaEncryptorError('ERR_FETCH_UNAVAILABLE');
  if (!url) throw new MetaEncryptorError('ERR_MISSING_PARAMS', { detail: { url: 'empty' } });

  log('HEAD ' + url);
  let headResp;
  try {
    headResp = await _fetch(url, { method: 'HEAD', cache: 'no-store', redirect: 'follow', signal });
  } catch (cause) {
    if (signal?.aborted) throw signal.reason || cause;
    throw new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', {
      detail: { status: cause?.message }, cause
    });
  }
  if (!headResp.ok) {
    throw new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', { detail: { status: headResp.status } });
  }
  const totalSize = exactContentLength(headResp);
  log(`HEAD status=${headResp.status} content-length=${totalSize}`);
  if (totalSize < HeaderSize) {
    throw new MetaEncryptorError('ERR_FILE_NOT_SEALED', { detail: { totalSize } });
  }

  const fetchUrl = resolvedFetchUrl(headResp, url);
  const etag = headResp.headers.get('ETag');
  const lastModified = headResp.headers.get('Last-Modified');
  const tailStart = totalSize - HeaderSize;
  const { response: tailResp } = await fetchRange(fetchUrl, {
    start: tailStart,
    end: totalSize - 1,
    fetch: _fetch,
    signal,
    expectedUrl: fetchUrl,
    etag,
    lastModified,
    totalSize,
  });
  const headerBuf = new Uint8Array(await tailResp.arrayBuffer());
  if (headerBuf.length !== HeaderSize) {
    throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE', {
      detail: { expected: HeaderSize, actual: headerBuf.length, totalSize }
    });
  }

  const { blockNumber, itemNumber } = validateHeader(headerBuf);
  const sealedContentSize = totalSize - HeaderSize - blockNumber * BlockInfoSize;
  if (!Number.isSafeInteger(sealedContentSize) || sealedContentSize < 0) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { reason: 'block metadata exceeds file size', totalSize, blockNumber }
    });
  }
  if (sealedContentSize === 0 && (blockNumber !== 0 || itemNumber !== 0)) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { reason: 'non-empty header describes empty content', blockNumber, itemNumber }
    });
  }
  if (sealedContentSize > 0 && itemNumber === 0) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { reason: 'zero items with trailing sealed content', sealedContentSize }
    });
  }

  // This is display/progress metadata only. Memory admission always uses the
  // conservative sealed total size, never this attacker-controlled estimate.
  const plaintextSizeEstimate = Math.max(0, sealedContentSize - itemNumber * 100);
  log(`header ok: blockNumber=${blockNumber} itemNumber=${itemNumber}`);
  return {
    totalSize,
    blockNumber,
    itemNumber,
    sealedContentSize,
    plaintextSizeEstimate,
    plaintextSize: plaintextSizeEstimate,
    finalUrl: fetchUrl,
    etag,
    lastModified,
  };
}

export async function downloadUnsealed(options = {}) {
  const onError = options?.onError;
  let log = noop;
  try {
    const {
      url,
      privateKey,
      filename,
      onLog,
      onProgress,
      onByteProgress,
      onDownloadReady,
      onSuccess,
      timeoutMs,
      maxSealedItemSize,
      streamSaver,
      fetch: fetchFn,
      signal,
    } = options || {};
    log = makeLogger(onLog);
    const key = typeof privateKey === 'string' ? privateKey.trim() : '';
    if (!url || !key || !filename) {
      throw new MetaEncryptorError('ERR_MISSING_PARAMS', {
        detail: {
          url: url ? 'set' : 'empty',
          key: key ? 'set' : 'empty',
          filename: filename || 'empty',
        }
      });
    }

    log('Checking file url=' + url + ' filename=' + filename);
    const meta = await inspectSealed(url, log, { fetch: fetchFn, signal });
    const mobile = isMobile();
    const limit = mobile ? MOBILE_LIMIT : DESKTOP_LIMIT;
    const downloadOptions = {
      log,
      onProgress,
      onByteProgress,
      size: meta.plaintextSizeEstimate,
      sealedSize: meta.totalSize,
      maxSize: limit,
      onDownloadReady,
      timeoutMs,
      maxSealedItemSize,
      fetch: fetchFn,
      signal,
      expectedEntity: {
        finalUrl: meta.finalUrl,
        totalSize: meta.totalSize,
        etag: meta.etag,
        lastModified: meta.lastModified,
      },
    };

    if (!mobile) {
      try {
        await streamDownloadAndDecrypt(url, key, filename, {
          ...downloadOptions,
          streamSaver,
        });
        onSuccess?.({ filename });
        return;
      } catch (error) {
        // This error is raised before any HTTP body is read or output written.
        // Every operational failure must remain terminal to prevent duplicate
        // downloads and partially-written output.
        if (error?.code !== 'ERR_NO_STREAM_WRITABLE') throw error;
        log('No streaming writable available; using Blob download');
      }
    }

    if (meta.totalSize > limit) {
      throw new MetaEncryptorError('ERR_FILE_TOO_LARGE', {
        detail: { size: meta.totalSize, limit, mode: mobile ? 'mobile blob' : 'desktop blob' }
      });
    }
    await blobDownloadAndDecrypt(url, key, filename, downloadOptions);
    onSuccess?.({ filename });
  } catch (error) {
    log('Download failed: ' + (error?.message || error));
    if (typeof onError === 'function') onError(error);
    else throw error;
  }
}

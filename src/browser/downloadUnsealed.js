

import { HeaderSize, BlockInfoSize } from '../common/limits.js';
import { validateHeader } from '../common/unsealer_core.js';
import { MetaEncryptorError } from '../common/errors.js';
import { blobDownloadAndDecrypt } from './blob_download.js';
import { streamDownloadAndDecrypt } from './stream_download.js';
import { fetchRange } from './fetchRange.js';

const MOBILE_LIMIT = 200 * 1024 * 1024;
const DESKTOP_LIMIT = 1024 * 1024 * 1024;

function isMobile() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
}

function makeLogger(onLog) {
  return (msg) => {
    const line = String(msg);
    if (onLog) onLog(line);
  };
}

async function inspectSealed(url, log) {
  log('HEAD ' + url);
  let headResp;
  try {
    headResp = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  } catch (e) {
    throw new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', { detail: { status: e.message }, cause: e });
  }
  const headCl = headResp.headers.get('Content-Length');
  const acceptRanges = headResp.headers.get('Accept-Ranges');
  log(`HEAD status=${headResp.status} content-length=${headCl ?? '(none)'} accept-ranges=${acceptRanges ?? '(none)'}`);
  if (!headResp.ok) throw new MetaEncryptorError('ERR_HEAD_REQUEST_FAILED', { detail: { status: headResp.status } });

  const totalSize = parseInt(headCl || '0', 10);
  if (totalSize < HeaderSize) {
    throw new MetaEncryptorError('ERR_FILE_NOT_SEALED', { detail: { totalSize } });
  }

  const fetchUrl = headResp.url || url;
  if (fetchUrl !== url) {
    log(`HEAD redirected to: ${fetchUrl}`);
  }

  const tailStart = totalSize - HeaderSize;
  const rangeHeader = `bytes=${tailStart}-${totalSize - 1}`;
  log(`Range ${rangeHeader} (tail ${HeaderSize} bytes of ${totalSize})`);

  const { response: tailResp } = await fetchRange(fetchUrl, { start: tailStart, end: totalSize - 1 });

  const tailCl = tailResp.headers.get('Content-Length');
  const contentRange = tailResp.headers.get('Content-Range');
  const contentType = tailResp.headers.get('Content-Type');
  log(`Range status=${tailResp.status} content-length=${tailCl ?? '(none)'} content-range=${contentRange ?? '(none)'} content-type=${contentType ?? '(none)'}`);

  const headerBuf = new Uint8Array(await tailResp.arrayBuffer());
  if (headerBuf.length !== HeaderSize) {
    throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE', {
      detail: { expected: HeaderSize, actual: headerBuf.length, totalSize, rangeHeader, status: tailResp.status }
    });
  }

  const { blockNumber, itemNumber } = validateHeader(headerBuf);
  log('header ok: blockNumber=' + blockNumber + ' itemNumber=' + itemNumber);

  const sealedContentSize = totalSize - HeaderSize - blockNumber * BlockInfoSize;
  if (sealedContentSize <= 0) throw new MetaEncryptorError('ERR_EMPTY_CONTENT');

  // per-item overhead: 8 (len prefix) + 12 (IV) + 64 (public key) + 16 (GCM tag) = 100
  const plaintextSize = sealedContentSize - itemNumber * 100;

  return { totalSize, blockNumber, itemNumber, sealedContentSize, plaintextSize };
}



/**
 * Download and decrypt a sealed file.
 * @param {Object} options
 * @param {string} options.url
 * @param {string} options.privateKey - hex-encoded private key
 * @param {string} options.filename
 * @param {Function} [options.onLog]
 * @param {Function} [options.onProgress] - (total, processed, readBytes, writeBytes) => {}
 * @param {Function} [options.onDownloadReady] - HTTP 流首个数据块进入管道时触发（可关蒙层）
 * @param {Function} [options.onSuccess]
 * @param {Function} [options.onError]
 * @returns {Promise<void>}
 */
export async function downloadUnsealed({
  url,
  privateKey,
  filename,
  onLog,
  onProgress,
  onDownloadReady,
  onSuccess,
  onError
}) {
  const log = makeLogger(onLog);
  const key = privateKey.trim()

  try {
    if (!url || !key || !filename) {
      throw new MetaEncryptorError('ERR_MISSING_PARAMS', {
        detail: { url: url ? 'set' : 'empty', key: key ? 'set' : 'empty', filename: filename || 'empty' }
      });
    }

    log('Checking file url=' + url + ' filename=' + filename);
    const meta = await inspectSealed(url, log);
    log('inspect file succ');
    log(`Plaintext size=${meta.plaintextSize} bytes, sealed=${meta.sealedContentSize} bytes, totalSize=${meta.totalSize}`);

    const mobile = isMobile()
    const limit = mobile ? MOBILE_LIMIT : DESKTOP_LIMIT
    const mode = mobile ? 'mobile' : 'desktop'
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a';
    log(`Detected ${mode} (ua=${ua}), limit ${(limit / 1024 / 1024).toFixed(0)} MB`);

    if (meta.plaintextSize > limit) {
      throw new MetaEncryptorError('ERR_FILE_TOO_LARGE', {
        detail: { size: (meta.plaintextSize / 1024 / 1024).toFixed(0), mode, limit: (limit / 1024 / 1024).toFixed(0) }
      })
    }

    if (!mobile) {
      try {
        log('Trying stream download...')
        await streamDownloadAndDecrypt(url, key, filename, {
          log,
          onProgress,
          size: meta.plaintextSize,
          onDownloadReady,
        })
        if (onSuccess) onSuccess({ filename })
        return
      } catch (e) {
        log('Stream failed: ' + e.message + ', falling back to Blob')
      }
    }

    log('Using Blob download...')
    await blobDownloadAndDecrypt(url, key, filename, { log, onProgress, onDownloadReady })
    if (onSuccess) onSuccess({ filename })
  } catch (error) {
    log('Download failed: ' + error.message)
    if (onError) onError(error)
    else throw error
  }
}


import { Unsealer } from './Unsealer.js';
import { HttpSealedFileStream } from './HttpSealedFileStream.js';
import { MetaEncryptorError } from '../common/errors.js';
import { createProgressTransformer, createDownloadReadyTransformer } from '../common/progress.js';
import { createInactivityWatchdog } from '../common/watchdog.js';
import { DEFAULT_STALL_MS } from './stream_download.js';

function linkAbortSignal(source, controller) {
  if (!source) return () => {};
  const abort = () => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

export async function blobDownloadAndDecrypt(url, privateKeyHex, filename, {
  log,
  onProgress,
  onByteProgress,
  fetch: fetchFn,
  signal,
  size,
  sealedSize,
  maxSize,
  maxSealedItemSize,
  chunkSize,
  expectedEntity,
  onDownloadReady,
  timeoutMs,
} = {}) {
  log = log || (() => {});
  if (Number.isFinite(maxSize) && Number.isFinite(sealedSize) && sealedSize > maxSize) {
    throw new MetaEncryptorError('ERR_FILE_TOO_LARGE', {
      detail: { size: sealedSize, limit: maxSize, mode: 'blob' }
    });
  }

  const stallMs = timeoutMs === undefined ? DEFAULT_STALL_MS : timeoutMs;
  const abort = new AbortController();
  const unlinkAbort = linkAbortSignal(signal, abort);
  const watchdog = createInactivityWatchdog(stallMs, () => {
    log(`Blob download stalled: no data for ${stallMs}ms, aborting`);
    abort.abort(new MetaEncryptorError('ERR_STREAM_STALLED', { detail: { timeoutMs: stallMs } }));
  });

  try {
    if (abort.signal.aborted) throw abort.signal.reason;
    const chunks = [];
    let receivedPlaintext = 0;
    const stream = new HttpSealedFileStream(url, {
      fetch: fetchFn,
      signal: abort.signal,
      ...(chunkSize === undefined ? {} : { chunkSize }),
      expectedEntity,
    });
    const unsealer = new Unsealer({
      privateKeyHex: privateKeyHex.trim(),
      maxSealedItemSize,
      progressHandler: (total, processed, readBytes, writeBytes) => {
        onProgress?.(total, processed, readBytes, writeBytes);
      }
    });
    const watchdogTap = new TransformStream({
      transform(chunk, controller) {
        watchdog.kick();
        controller.enqueue(chunk);
      }
    });

    watchdog.kick();
    await stream
      .pipeThrough(watchdogTap)
      .pipeThrough(createDownloadReadyTransformer(onDownloadReady))
      .pipeThrough(unsealer)
      .pipeThrough(createProgressTransformer(size, onByteProgress))
      .pipeTo(new WritableStream({
        write(plain) {
          receivedPlaintext += plain.byteLength;
          if (Number.isFinite(maxSize) && receivedPlaintext > maxSize) {
            throw new MetaEncryptorError('ERR_FILE_TOO_LARGE', {
              detail: { size: receivedPlaintext, limit: maxSize, mode: 'blob' }
            });
          }
          chunks.push(new Uint8Array(plain));
        }
      }), { signal: abort.signal });

    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      try { anchor.click(); } finally { anchor.remove(); }
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    log('Download complete (client-side Blob decrypt)');
    return { ok: true };
  } catch (error) {
    const err = abort.signal.aborted && abort.signal.reason instanceof Error
      ? abort.signal.reason
      : error;
    log('Blob download failed: ' + (err?.message || err));
    throw err;
  } finally {
    watchdog.stop();
    unlinkAbort();
    if (!abort.signal.aborted) abort.abort();
  }
}

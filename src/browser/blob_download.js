import { Unsealer } from './Unsealer.js'
import { HttpSealedFileStream } from './HttpSealedFileStream.js'
import { MetaEncryptorError } from '../common/errors.js';
import { createProgressTransformer, createDownloadReadyTransformer } from '../common/progress.js';
import { createInactivityWatchdog } from '../common/watchdog.js';
import { DEFAULT_STALL_MS } from './stream_download.js';

/**
 * @param {string} url
 * @param {string} privateKeyHex
 * @param {string} filename
 * @param {{ log?: Function, onProgress?: Function, fetch?: Function, size?: number, onDownloadReady?: Function, timeoutMs?: number }} [opts]
 */
export async function blobDownloadAndDecrypt(url, privateKeyHex, filename, { log, onProgress, fetch: _fetch, size, onDownloadReady, timeoutMs } = {}) {
  log = log || (() => {})

  const stallMs = timeoutMs === undefined ? DEFAULT_STALL_MS : timeoutMs;
  const abort = new AbortController();
  const watchdog = createInactivityWatchdog(stallMs, () => {
    log(`Blob download stalled: no data for ${stallMs}ms, aborting`);
    abort.abort(new MetaEncryptorError('ERR_STREAM_STALLED', { detail: { timeoutMs: stallMs } }));
  });

  try {
    const chunks = []

    const stream = new HttpSealedFileStream(url, { fetch: _fetch, signal: abort.signal })
    const unsealer = new Unsealer({
      privateKeyHex: privateKeyHex.trim(),
      progressHandler: (total, processed, readBytes, writeBytes) => {
        if (onProgress) onProgress(total, processed, readBytes, writeBytes)
      }
    })
    const watchdogTap = new TransformStream({
      transform(chunk, controller) {
        watchdog.kick();
        controller.enqueue(chunk);
      }
    })

    watchdog.kick();
    await stream
      .pipeThrough(watchdogTap)
      .pipeThrough(createDownloadReadyTransformer(onDownloadReady))
      .pipeThrough(unsealer)
      .pipeThrough(createProgressTransformer(size, onProgress))
      .pipeTo(new WritableStream({
        write(plain) {
          chunks.push(new Uint8Array(plain))
        }
      }), { signal: abort.signal })

    const blob = new Blob(chunks, { type: 'application/octet-stream' })
    const urlObj = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = urlObj
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(urlObj)
    log('Download complete (client-side Blob decrypt)');
    return { ok: true }
  } catch (e) {
    const err = (abort.signal.aborted && abort.signal.reason instanceof Error) ? abort.signal.reason : e;
    log('Blob download failed: ' + err.message);
    throw err
  } finally {
    watchdog.stop();
  }
}

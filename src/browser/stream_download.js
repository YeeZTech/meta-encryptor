import { Unsealer } from './Unsealer.js'
import { HttpSealedFileStream } from './HttpSealedFileStream.js'
import { MetaEncryptorError } from '../common/errors.js';
import { createProgressTransformer, createDownloadReadyTransformer } from '../common/progress.js';
import { createInactivityWatchdog } from '../common/watchdog.js';

export const DEFAULT_STALL_MS = 60 * 1000;

const STREAMSAVER_LOAD_TIMEOUT_MS = 4000;

async function ensureStreamSaver(log) {
  if (typeof window === 'undefined') return null;
  if (window.streamSaver?.createWriteStream) return window.streamSaver;

  try {
    log?.('Loading StreamSaver...');
    // The CDN may be unreachable (blocked networks) and the <script> then
    // neither loads nor errors — without a timeout the whole download hangs
    // here instead of falling back to FSA/Blob.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('StreamSaver load timeout')),
        STREAMSAVER_LOAD_TIMEOUT_MS
      );
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/streamsaver@2.0.3/StreamSaver.min.js';
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = (e) => { clearTimeout(timer); reject(e); };
      document.head.appendChild(s);
    });
    if (window.streamSaver?.createWriteStream) {
      window.streamSaver.mitm = 'https://jimmywarting.github.io/StreamSaver.js/mitm.html?version=2.0.6';
      return window.streamSaver;
    }
  } catch {
    log?.('StreamSaver load failed');
  }
  return null;
}

export async function getBestWritable(filename, { log } = {}) {
  const ss = await ensureStreamSaver(log);
  if (ss) {
    log?.('Using StreamSaver...');
    // Never declare a size: the exact plaintext size cannot be computed from
    // the sealed header (only over-estimated). Declaring a too-large
    // Content-Length pins the browser download just below 100% forever.
    return ss.createWriteStream(filename);
  }

  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      log?.('Using File System Access API...');
      const handle = await window.showSaveFilePicker({ suggestedName: filename });
      return await handle.createWritable();
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      log?.(`File System Access API unavailable: ${e.message}`);
    }
  }

  return null;
}

export async function streamDownloadAndDecrypt(url, privateKeyHex, filename, { log, onProgress, writable, size, fetch: _fetch, onDownloadReady, timeoutMs } = {}) {
  log = log || (() => {})

  const stallMs = timeoutMs === undefined ? DEFAULT_STALL_MS : timeoutMs;
  const abort = new AbortController();
  const watchdog = createInactivityWatchdog(stallMs, () => {
    log(`Stream stalled: no data for ${stallMs}ms, aborting`);
    abort.abort(new MetaEncryptorError('ERR_STREAM_STALLED', { detail: { timeoutMs: stallMs } }));
  });

  try {
    const out = writable || await getBestWritable(filename, { log })
    if (!out) throw new MetaEncryptorError('ERR_NO_STREAM_WRITABLE');
    log('Stream download starting...');

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
      .pipeTo(out, { signal: abort.signal })

    log('Download complete');
    return { ok: true }
  } catch (e) {
    // surface the stall reason instead of a generic AbortError
    const err = (abort.signal.aborted && abort.signal.reason instanceof Error) ? abort.signal.reason : e;
    log('Stream download failed: ' + err.message);
    throw err
  } finally {
    watchdog.stop();
  }
}

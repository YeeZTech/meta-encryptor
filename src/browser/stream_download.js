import { Unsealer } from './Unsealer.js';
import { HttpSealedFileStream } from './HttpSealedFileStream.js';
import { MetaEncryptorError } from '../common/errors.js';
import { createProgressTransformer, createDownloadReadyTransformer } from '../common/progress.js';
import { createInactivityWatchdog } from '../common/watchdog.js';

export const DEFAULT_STALL_MS = 60 * 1000;

function trustedStreamSaver(explicit) {
  if (explicit?.createWriteStream) return explicit;
  if (globalThis.streamSaver?.createWriteStream) return globalThis.streamSaver;
  if (globalThis.window?.streamSaver?.createWriteStream) return globalThis.window.streamSaver;
  return null;
}

/** Select a writable without downloading or executing any remote code. */
export async function getBestWritable(filename, { log, streamSaver } = {}) {
  const ss = trustedStreamSaver(streamSaver);
  if (ss) {
    log?.('Using StreamSaver...');
    return ss.createWriteStream(filename);
  }

  const picker = globalThis.showSaveFilePicker || globalThis.window?.showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      log?.('Using File System Access API...');
      const handle = await picker.call(globalThis.window || globalThis, { suggestedName: filename });
      return await handle.createWritable();
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      log?.(`File System Access API unavailable: ${error?.message || error}`);
      return null;
    }
  }
  return null;
}

function linkAbortSignal(source, controller) {
  if (!source) return () => {};
  const abort = () => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

export async function streamDownloadAndDecrypt(url, privateKeyHex, filename, {
  log,
  onProgress,
  onByteProgress,
  writable,
  size,
  fetch: fetchFn,
  signal,
  streamSaver,
  maxSealedItemSize,
  chunkSize,
  expectedEntity,
  onDownloadReady,
  timeoutMs,
} = {}) {
  log = log || (() => {});
  const stallMs = timeoutMs === undefined ? DEFAULT_STALL_MS : timeoutMs;
  const abort = new AbortController();
  const unlinkAbort = linkAbortSignal(signal, abort);
  const watchdog = createInactivityWatchdog(stallMs, () => {
    log(`Stream stalled: no data for ${stallMs}ms, aborting`);
    abort.abort(new MetaEncryptorError('ERR_STREAM_STALLED', { detail: { timeoutMs: stallMs } }));
  });

  try {
    if (abort.signal.aborted) throw abort.signal.reason;
    const out = writable || await getBestWritable(filename, { log, streamSaver });
    if (!out) throw new MetaEncryptorError('ERR_NO_STREAM_WRITABLE');
    if (abort.signal.aborted) throw abort.signal.reason;
    log('Stream download starting...');

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
      .pipeTo(out, { signal: abort.signal });

    log('Download complete');
    return { ok: true };
  } catch (error) {
    const err = abort.signal.aborted && abort.signal.reason instanceof Error
      ? abort.signal.reason
      : error;
    log('Stream download failed: ' + (err?.message || err));
    throw err;
  } finally {
    watchdog.stop();
    unlinkAbort();
    if (!abort.signal.aborted) abort.abort();
  }
}

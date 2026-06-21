import { Unsealer } from './Unsealer.js'
import { HttpSealedFileStream } from './HttpSealedFileStream.js'
import { MetaEncryptorError } from '../common/errors.js';

async function ensureStreamSaver(log) {
  if (typeof window === 'undefined') return null;
  if (window.streamSaver?.createWriteStream) return window.streamSaver;

  try {
    log?.('Loading StreamSaver...');
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/streamsaver@2.0.3/StreamSaver.min.js';
      s.onload = resolve;
      s.onerror = reject;
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

export async function getBestWritable(filename, { log, size } = {}) {
  /*
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
  */

  const ss = await ensureStreamSaver(log);
  if (ss) {
    log?.('Using StreamSaver...');
    return ss.createWriteStream(filename, size !== undefined ? { size } : undefined);
  }

  return null;
}

export async function streamDownloadAndDecrypt(url, privateKeyHex, filename, { log, onProgress, writable, size, fetch: _fetch } = {}) {
  log = log || (() => {})
  try {
    const out = writable || await getBestWritable(filename, { log, size })
    if (!out) throw new MetaEncryptorError('ERR_NO_STREAM_WRITABLE');
    log('Stream download starting...');

    const stream = new HttpSealedFileStream(url, { fetch: _fetch })
    const unsealer = new Unsealer({
      privateKeyHex: privateKeyHex.trim(),
      progressHandler: (total, processed, readBytes, writeBytes) => {
        if (onProgress) onProgress(total, processed, readBytes, writeBytes)
      }
    })

    await stream
      .pipeThrough(unsealer)
      .pipeTo(out)

    log('Download complete');
    return { ok: true }
  } catch (e) {
    log('Stream download failed: ' + e.message);
    throw e
  }
}

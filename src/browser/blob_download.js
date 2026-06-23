import { Unsealer } from './Unsealer.js'
import { HttpSealedFileStream } from './HttpSealedFileStream.js'
import { createProgressTransformer, createDownloadReadyTransformer } from '../common/progress.js';

/**
 * @param {string} url
 * @param {string} privateKeyHex
 * @param {string} filename
 * @param {{ log?: Function, onProgress?: Function, fetch?: Function, size?: number, onDownloadReady?: Function }} [opts]
 */
export async function blobDownloadAndDecrypt(url, privateKeyHex, filename, { log, onProgress, fetch: _fetch, size, onDownloadReady } = {}) {
  log = log || (() => {})
  try {
    const chunks = []

    const stream = new HttpSealedFileStream(url, { fetch: _fetch })
    const unsealer = new Unsealer({
      privateKeyHex: privateKeyHex.trim(),
      progressHandler: (total, processed, readBytes, writeBytes) => {
        if (onProgress) onProgress(total, processed, readBytes, writeBytes)
      }
    })

    await stream
      .pipeThrough(createDownloadReadyTransformer(onDownloadReady))
      .pipeThrough(unsealer)
      .pipeThrough(createProgressTransformer(size, onProgress))
      .pipeTo(new WritableStream({
        write(plain) {
          chunks.push(new Uint8Array(plain))
        }
      }))

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
    log('Blob download failed: ' + e.message);
    throw e
  }
}
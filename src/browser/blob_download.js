import { Unsealer } from './Unsealer.js'
import { HttpSealedFileStream } from './HttpSealedFileStream.js'


/**
 * 用 HttpSealedFileStream 下载加密文件 → Unsealer 解密 → 内存收集 → Blob 下载
 */
/**
 * @param {string} url
 * @param {string} privateKeyHex
 * @param {string} filename
 * @param {{ log?: Function, onProgress?: Function, fetch?: Function }} [opts]
 */
export async function blobDownloadAndDecrypt(url, privateKeyHex, filename, { log, onProgress, fetch: _fetch } = {}) {
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
      .pipeThrough(unsealer)
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
    log('下载完成 (页面端解密 Blob)')
    return { ok: true }
  } catch (e) {
    log('Blob 下载失败: ' + e.message)
    throw e
  }
}
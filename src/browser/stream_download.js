import { Unsealer } from './Unsealer.js'
import { HttpSealedFileStream } from './HttpSealedFileStream.js'

/**
 * 流式下载并解密，直接写入文件（通过 StreamSaver），无需将完整明文加载到内存。
 *
 * @param {string} url - 加密文件 URL
 * @param {string} privateKeyHex - 私钥 hex
 * @param {string} filename - 下载文件名
 * @param {{ log?: Function, onProgress?: Function }} [opts]
 */
export async function streamDownloadAndDecrypt(url, privateKeyHex, filename, { log, onProgress, writable, fetch: _fetch } = {}) {
  log = log || (() => {})
  try {
    const out = writable || (window.streamSaver && window.streamSaver.createWriteStream(filename))
    if (!out) throw new Error('StreamSaver not available and no writable provided')
    log('使用 StreamSaver 流式下载...')

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

    log('下载完成 (StreamSaver)')
    return { ok: true }
  } catch (e) {
    log('流式下载失败: ' + e.message)
    throw e
  }
}

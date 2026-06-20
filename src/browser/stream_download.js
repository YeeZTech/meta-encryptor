import { Unsealer } from './Unsealer.js'
import { HttpSealedFileStream } from './HttpSealedFileStream.js'

/**
 * 动态加载 StreamSaver CDN 脚本（仅当浏览器环境且尚未加载时）
 */
async function ensureStreamSaver(log) {
  if (typeof window === 'undefined') return null;
  if (window.streamSaver?.createWriteStream) return window.streamSaver;

  try {
    log?.('正在加载 StreamSaver...');
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
    log?.('StreamSaver 加载失败');
  }
  return null;
}

/**
 * 获取最佳可写流，按优先级：
 * 1. File System Access API（showSaveFilePicker，Chromium 原生）
 * 2. StreamSaver（CDN 动态加载）
 * 3. 返回 null（调用方走 Blob 兜底）
 */
export async function getBestWritable(filename, { log } = {}) {
  // 1. File System Access API
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      log?.('使用 File System Access API 流式下载...');
      const handle = await window.showSaveFilePicker({ suggestedName: filename });
      return await handle.createWritable();
    } catch (e) {
      if (e?.name === 'AbortError') throw e; // 用户取消
      log?.(`File System Access API 不可用: ${e.message}`);
    }
  }

  // 2. StreamSaver CDN
  const ss = await ensureStreamSaver(log);
  if (ss) {
    log?.('使用 StreamSaver 流式下载...');
    return ss.createWriteStream(filename);
  }

  return null;
}

/**
 * 流式下载并解密，直接写入文件（自动选择最佳 writable），无需将完整明文加载到内存。
 */
export async function streamDownloadAndDecrypt(url, privateKeyHex, filename, { log, onProgress, writable, fetch: _fetch } = {}) {
  log = log || (() => {})
  try {
    const out = writable || await getBestWritable(filename, { log })
    if (!out) throw new Error('无可用的流式下载方式')
    log('流式下载开始...')

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

    log('下载完成')
    return { ok: true }
  } catch (e) {
    log('流式下载失败: ' + e.message)
    throw e
  }
}



import { HeaderSize, BlockInfoSize } from '../common/limits.js';
import { validateHeader } from '../common/unsealer_core.js';
import { blobDownloadAndDecrypt } from './blob_download.js';
import { streamDownloadAndDecrypt } from './stream_download.js';

// 大小限制
const MOBILE_LIMIT = 200 * 1024 * 1024;   // 200 MB
const DESKTOP_LIMIT = 1024 * 1024 * 1024; // 1 GB

/** 简单判断是否为移动端 */
function isMobile() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
}

// 检查文件并获取元数据，校验 magic number 和版本号
async function inspectSealed(url) {
  const headResp = await fetch(url, { method: 'HEAD' });
  if (!headResp.ok) throw new Error(`HEAD 请求失败: HTTP ${headResp.status}`);

  const totalSize = parseInt(headResp.headers.get('Content-Length') || '0', 10);
  if (totalSize < HeaderSize) throw new Error('文件太小，不是有效的封装文件');

  // 读取末尾 header
  const tailStart = totalSize - HeaderSize;
  const tailResp = await fetch(url, {
    headers: { Range: `bytes=${tailStart}-${totalSize - 1}` }
  });
  if (!tailResp.ok) throw new Error(`无法读取文件末尾: HTTP ${tailResp.status}`);

  const headerBuf = new Uint8Array(await tailResp.arrayBuffer());
  if (headerBuf.length !== HeaderSize) throw new Error('文件 header 不完整');

  // validateHeader 校验 magic number 和 version，同时返回 blockNumber
  const { blockNumber } = validateHeader(headerBuf);

  const contentSize = totalSize - HeaderSize - blockNumber * BlockInfoSize;
  if (contentSize <= 0) throw new Error('无效的封装文件：内容大小为0');

  return { totalSize, blockNumber, contentSize };
}



/**
 * 下载并解密加密文件
 * @param {Object} options 配置选项
 * @param {string} options.url - 加密文件的 URL（支持 Range 请求）
 * @param {string} options.privateKey - 私钥（hex 格式，64字节）
 * @param {string} options.filename - 下载文件名
 * @param {Function} [options.onLog] - 日志回调函数
 * @param {Function} [options.onProgress] - 进度回调函数 (total, processed, readBytes, writeBytes) => {}
 * @param {Function} [options.onSuccess] - 成功回调函数 (data) => {}
 * @param {Function} [options.onError] - 错误回调函数 (error) => {}
 * @returns {Promise<void>}
 */
export async function downloadUnsealed({
  url,
  privateKey,
  filename,
  onLog,
  onProgress,
  onSuccess,
  onError
}) {
  const log = onLog || (() => {})
  const key = privateKey.trim()

  try {
    if (!url || !key || !filename) throw new Error('请提供 URL、私钥和文件名')

    log('检查文件..., url ', url)
    const meta = await inspectSealed(url)
    log('inspect file succ')
    log(`明文大小(估算)=${meta.contentSize} 字节`)

    // 大小上限
    const mobile = isMobile()
    const limit = mobile ? MOBILE_LIMIT : DESKTOP_LIMIT
    const mode = mobile ? 'mobile' : 'desktop'
    log(`检测到 ${mode} 端，大小限制 ${(limit / 1024 / 1024).toFixed(0)} MB`)

    if (meta.contentSize > limit) {
      throw new Error(`文件过大 (${(meta.contentSize / 1024 / 1024).toFixed(0)} MB)，超出 ${mode} 端限制 ${(limit / 1024 / 1024).toFixed(0)} MB`)
    }

    // 桌面端优先 stream；移动端或 stream 不可用时走 blob
    const tryStream = !mobile && typeof window !== 'undefined' && window.streamSaver && typeof window.streamSaver.createWriteStream === 'function'

    if (tryStream) {
      try {
        log('使用流式下载 (StreamSaver)...')
        await streamDownloadAndDecrypt(url, key, filename, { log, onProgress })
        if (onSuccess) onSuccess({ filename })
        return
      } catch (e) {
        log(`流式下载失败: ${e.message}，回退到 Blob 下载`)
      }
    }

    // blob 兜底
    log('使用 Blob 下载...')
    await blobDownloadAndDecrypt(url, key, filename, { log, onProgress })
    if (onSuccess) onSuccess({ filename })
  } catch (error) {
    log('下载失败: ' + error.message)
    if (onError) onError(error)
    else throw error
  }
}


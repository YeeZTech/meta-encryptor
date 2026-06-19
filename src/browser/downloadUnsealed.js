
import { unsealStream } from './UnsealerBrowser.js'
import { prepareSealedResponse } from './SealedHttpTailHeaderTransform.js'

// 检查文件并获取元数据
async function inspectSealed(url) {
  const HEADER_SIZE = 64
  const BLOCK_INFO_SIZE = 32
  
  try {
    const headResp = await fetch(url, { method: 'HEAD' })
    console.log('[inspect] HEAD resp:', headResp.status, headResp.headers);
    const totalSize = parseInt(headResp.headers.get('Content-Length') || '0', 10)
    
    if (totalSize < HEADER_SIZE) {
      return { totalSize, blockNumber: null, contentSize: null }
    }
    
    // 读取文件末尾的 header
    const tailStart = Math.max(0, totalSize - HEADER_SIZE)
    const tailResp = await fetch(url, {
      headers: { Range: `bytes=${tailStart}-${totalSize - 1}` }
    })
    
    if (!tailResp.ok) {
      return { totalSize, blockNumber: null, contentSize: null }
    }
    
    const headerBuf = new Uint8Array(await tailResp.arrayBuffer())
    if (headerBuf.length !== HEADER_SIZE) {
      return { totalSize, blockNumber: null, contentSize: null }
    }
    
    // 解析 header 获取 blockNumber
    const blockNumber = new DataView(headerBuf.buffer).getBigUint64(16, true)
    const contentSize = totalSize - HEADER_SIZE - Number(blockNumber) * BLOCK_INFO_SIZE
    
    if (contentSize <= 0) {
      return { totalSize, blockNumber: Number(blockNumber), contentSize: null }
    }
    
    return { totalSize, blockNumber: Number(blockNumber), contentSize }
  } catch (e) {
    return { totalSize: 0, blockNumber: null, contentSize: null }
  }
}

// 在页面中解密并通过 Blob 下载（回退方案）
async function blobDownloadAndDecrypt(url, privateKeyHex, filename, { log, onProgress } = {}) {
  log = log || (() => {})
  try {
    const resp = await prepareSealedResponse(url, { log, chunked: false })
    if (!resp.ok) throw new Error('HTTP 状态: ' + resp.status)

    const chunks = []
    const BATCH_SIZE = 512 * 1024
    let batch = new Uint8Array(BATCH_SIZE)
    let batchLen = 0

    await unsealStream(resp, {
      privateKeyHex: privateKeyHex.trim(),
      onChunk: async (plain) => {
        const len = plain?.length || 0
        if (len === 0) return
        let off = 0
        while (off < len) {
          const can = Math.min(BATCH_SIZE - batchLen, len - off)
          batch.set(plain.subarray(off, off + can), batchLen)
          batchLen += can
          off += can
          if (batchLen === BATCH_SIZE) {
            chunks.push(batch.slice(0, batchLen))
            batch = new Uint8Array(BATCH_SIZE)
            batchLen = 0
          }
        }
      },
      progressHandler: (total, processed, readBytes, writeBytes) => {
        if (onProgress) onProgress(total, processed, readBytes, writeBytes)
      }
    })

    if (batchLen > 0) chunks.push(batch.subarray(0, batchLen))

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

// 使用 Service Worker 在 SW 中完成 fetch + 解密 并触发原生下载
// SW 端需实现对 type 'DOWNLOAD_REQUEST' 的处理，使用 postMessage 通信回 progress / success / error
async function swDownloadAndDecrypt(url, privateKeyHex, filename, { log, onProgress } = {}) {
  log = log || (() => {})
  if (!('serviceWorker' in navigator)) throw new Error('Service Worker 不可用')

  // 查找或注册 SW
  let reg = null
  let scope = '/'
  const existingRegistrations = await navigator.serviceWorker.getRegistrations()
  for (const existingReg of existingRegistrations) {
    if (existingReg.scope === '/' || existingReg.scope.startsWith('/')) {
      reg = existingReg
      scope = existingReg.scope
      log(`[Download] 复用已注册的 Service Worker: ${scope}`)
      break
    }
  }
  if (!reg) {
    const swPaths = ['/sw-download.js', '/example/browser/sw-download.js']
        for (const pathStr of swPaths) {
      try {
        scope = pathStr.replace(/\/[^/]*$/, '/') || '/'
        reg = await navigator.serviceWorker.register(pathStr, { scope, type: 'module' })
        log(`[Download] 注册 Service Worker: ${pathStr}, scope: ${scope}`)
        break
      } catch (e) {
        continue
      }
    }
    if (!reg) throw new Error('无法注册 Service Worker，所有路径都失败')
  }

  await navigator.serviceWorker.ready

  function ensureController() {
    if (navigator.serviceWorker.controller) return Promise.resolve(navigator.serviceWorker.controller)
    if (reg.active) return Promise.resolve(reg.active)
    return new Promise((resolve) => {
      const to = setTimeout(resolve, 1500)
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(to)
        resolve()
      }, { once: true })
    }).then(() => navigator.serviceWorker.controller || reg.active || null)
  }

  const controller = await ensureController()
  if (!controller) throw new Error('Service Worker 未接管此页面')

  const id = Math.random().toString(36).slice(2)

  // 为 SW 传递最小必要信息（由 SW 端负责 fetch+解密）
  ;(reg.active || controller).postMessage({
    type: 'DOWNLOAD_REQUEST',
    id,
    name: filename,
    payload: { url, privateKeyHex }
  })

  // 触发 iframe 导航以启动下载（SW 拦截并返回解密后的流）
  try {
    const downloadUrl = `/download/unsealed?id=${encodeURIComponent(id)}`
    const iframe = document.createElement('iframe')
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:none;opacity:0;pointer-events:none;'
    document.body.appendChild(iframe)

    let iframeRemoved = false
    const removeIframe = () => { if (!iframeRemoved && iframe.parentNode) { document.body.removeChild(iframe); iframeRemoved = true } }
    iframe.onload = () => setTimeout(removeIframe, 100)
    setTimeout(() => { if (!iframeRemoved) removeIframe() }, 5000)
    iframe.src = downloadUrl
  } catch (e) {
    try {
      const w = window.open(`/download/unsealed?id=${encodeURIComponent(id)}`, '_blank')
      if (!w) {
        const a = document.createElement('a')
        a.href = `/download/unsealed?id=${encodeURIComponent(id)}`
        a.target = '_blank'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }
    } catch (e2) {
      // ignore
    }
  }

  // resolve immediately after triggering download; progress is handled by browser's native UI
  return Promise.resolve({ ok: true, triggered: true })
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
  
  try {
    if (!url || !privateKey || !filename) {
      throw new Error('请提供 URL、私钥和文件名')
    }

    log('开始获取加密文件流...')

    // 检查文件并获取元数据
    const meta = await inspectSealed(url)
    const expectedPlainBytes = meta.contentSize || undefined

    if (expectedPlainBytes) {
      log(`明文总大小(估算)=${expectedPlainBytes} 字节`)
    } else {
      log('未能获取明文总大小：以未知大小模式开始下载')
    }

    // 准备响应流
    const resp = await prepareSealedResponse(url, {
      log,
      chunked: false
    })

    if (!resp.ok) {
      throw new Error('HTTP 状态: ' + resp.status)
    }

    log('1已连接，开始尝试使用 Service Worker 在 SW 端完成解密并下载...')

    // 优先尝试让 Service Worker 在 SW 端完成 fetch + 解密并触发原生下载
    try {
      await swDownloadAndDecrypt(url, privateKey.trim(), filename, { log, onProgress })
      if (onSuccess) onSuccess({ filename })
      return
    } catch (e) {
      log('SW 方案失败或不可用: ' + (e && e.message ? e.message : e))
    }

    // 回退到在页面中解密并生成 Blob 下载
    log('回退到页面端解密并生成 Blob 下载...')
    await blobDownloadAndDecrypt(url, privateKey.trim(), filename, { log, onProgress })
    if (onSuccess) onSuccess({ filename })
  } catch (error) {
    log('下载失败: ' + error.message)
    if (onError) {
      onError(error)
    } else {
      throw error
    }
  }
}


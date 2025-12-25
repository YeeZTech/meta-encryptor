
import { unsealStream } from './UnsealerBrowser.js'
import { prepareSealedResponse } from './SealedHttpTailHeaderTransform.js'

// 检查文件并获取元数据
async function inspectSealed(url) {
  const HEADER_SIZE = 64
  const BLOCK_INFO_SIZE = 32
  
  try {
    const headResp = await fetch(url, { method: 'HEAD' })
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

// 下载写入器：自动选择最佳方案
async function withNativeDownloadWriter(filename, expectedSize, log) {
  log = log || (() => {})
  
  // 方案1: Service Worker
  if ('serviceWorker' in navigator) {
    try {
      // 先检查是否已经有注册的 Service Worker，避免重复注册导致正在进行的下载中断
      let reg = null
      let scope = '/'
      
      // 检查现有的注册
      const existingRegistrations = await navigator.serviceWorker.getRegistrations()
      for (const existingReg of existingRegistrations) {
        // 检查是否是我们需要的 Service Worker（通过 scope 判断）
        if (existingReg.scope === '/' || existingReg.scope.startsWith('/')) {
          reg = existingReg
          scope = existingReg.scope
          log(`[Download] 复用已注册的 Service Worker: ${scope}`)
          break
        }
      }
      
      // 如果没有找到已注册的，才进行注册
      if (!reg) {
        const swPaths = [
          '/sw-download.js',
          '/example/browser/sw-download.js',
        ]
        
        for (const pathStr of swPaths) {
          try {
            scope = pathStr.replace(/\/[^/]*$/, '/') || '/'
            reg = await navigator.serviceWorker.register(pathStr, { scope })
            log(`[Download] 注册 Service Worker: ${pathStr}, scope: ${scope}`)
            break
          } catch (e) {
            continue
          }
        }
        
        if (!reg) {
          throw new Error('无法注册 Service Worker，所有路径都失败')
        }
      }
      
      await navigator.serviceWorker.ready
      
      async function ensureController() {
        if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller
        if (reg.active) return reg.active
        await new Promise((resolve) => {
          const to = setTimeout(resolve, 1500)
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => {
              clearTimeout(to)
              resolve()
            },
            { once: true }
          )
        })
        return navigator.serviceWorker.controller || reg.active || null
      }
      const controller = await ensureController()
      if (!controller) {
        throw new Error('Service Worker 未接管此页面')
      }

      const id = Math.random().toString(36).slice(2)
      const ch = new MessageChannel()
      const size = typeof expectedSize === 'number' && isFinite(expectedSize) ? expectedSize : undefined
      
      let portReady = false
      const ackPromise = new Promise((resolve) => {
        const to = setTimeout(resolve, 800)
        ch.port1.onmessage = (ev) => {
          if (ev.data && ev.data.type === 'ready') {
            portReady = true
            clearTimeout(to)
            resolve()
          }
        }
      })
      ;(reg.active || controller).postMessage(
        { type: 'DOWNLOAD_PORT', id, name: filename, size },
        [ch.port2]
      )
      await ackPromise

      const downloadUrl = `/download/unsealed?id=${encodeURIComponent(id)}`
      
      // 使用隐藏的 iframe 触发下载，避免新标签页闪屏
      // Service Worker 会拦截请求并返回下载响应，iframe 仅用于触发请求
      try {
        const iframe = document.createElement('iframe')
        iframe.style.cssText = 'position:absolute;width:0;height:0;border:none;opacity:0;pointer-events:none;'
        document.body.appendChild(iframe)
        
        let iframeRemoved = false
        const removeIframe = () => {
          if (!iframeRemoved && iframe.parentNode) {
            document.body.removeChild(iframe)
            iframeRemoved = true
          }
        }
        
        // 监听 load 事件，加载完成后移除 iframe
        // Service Worker 拦截后，iframe 会快速加载完成，此时下载已开始
        iframe.onload = () => {
          setTimeout(() => {
            removeIframe()
          }, 100) // 短暂延迟确保下载已触发
        }
        
        // 设置超时，防止 iframe 加载失败时永远不清理
        setTimeout(() => {
          if (!iframeRemoved) {
            removeIframe()
          }
        }, 5000)
        
        iframe.src = downloadUrl
      } catch (e) {
        // iframe 失败，回退到 window.open
        try {
          const w = window.open(downloadUrl, '_blank')
          if (!w) {
            // Fallback if popup blocked: temporary anchor without download attribute (navigation)
            const a = document.createElement('a')
            a.href = downloadUrl
            a.target = '_blank'
            document.body.appendChild(a)
            a.click()
            a.remove()
          }
        } catch (e2) {
          // 如果所有方法都失败，抛出错误
          throw new Error(`无法触发下载: ${e2.message}`)
        }
      }
      
      log(`[Download] 使用同源 SW 原生下载（隐藏 iframe，减少闪屏），size=${size ?? '未知'}`)
      return {
        async write(u8) {
          const copy = u8 && u8.byteLength ? (u8.slice ? u8.slice() : new Uint8Array(u8)) : new Uint8Array()
          ch.port1.postMessage({ type: 'chunk', data: copy }, [copy.buffer])
        },
        async close() {
          ch.port1.postMessage({ type: 'end' })
          ch.port1.close()
        }
      }
    } catch (e) {
      log('[Download] 注册/使用同源 SW 失败: ' + e.message)
    }
  }
  
  // 方案2: StreamSaver
  if (window.streamSaver && typeof window.streamSaver.createWriteStream === 'function') {
    try {
      const fileStream = window.streamSaver.createWriteStream(filename, { size: expectedSize })
      const writer = fileStream.getWriter()
      log(`[Download] 使用 StreamSaver 原生下载，size=${expectedSize ?? '未知'}`)
      return {
        async write(u8) {
          await writer.write(u8)
        },
        async close() {
          await writer.close()
        }
      }
    } catch (e) {
      log('[Download] StreamSaver 失败，回退: ' + e.message)
    }
  }
  
  // 方案3: Blob 下载
  log('[Download] 回退到 Blob 下载')
  const chunks = []
  return {
    async write(u8) {
      chunks.push(u8)
    },
    async close() {
      const blob = new Blob(chunks, { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  }
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

    log('已连接，开始解密并写入文件...')

    // 创建下载写入器
    const writer = await withNativeDownloadWriter(filename, expectedPlainBytes, log)

    // 批量写入缓冲区
    const BATCH_SIZE = 512 * 1024 // 512KB
    let batch = new Uint8Array(BATCH_SIZE)
    let batchLen = 0

    // 流式解密并保存
    await unsealStream(resp, {
      privateKeyHex: privateKey.trim(),
      onChunk: async (plain) => {
        const len = plain?.length || 0
        if (len === 0) return

        // 批量写入
        let off = 0
        while (off < len) {
          const can = Math.min(BATCH_SIZE - batchLen, len - off)
          batch.set(plain.subarray(off, off + can), batchLen)
          batchLen += can
          off += can
          if (batchLen === BATCH_SIZE) {
            await writer.write(batch)
            batchLen = 0
          }
        }
      },
      progressHandler: (total, processed, readBytes, writeBytes) => {
        if (onProgress) {
          onProgress(total, processed, readBytes, writeBytes)
        }
      }
    })

    // 写入剩余数据
    if (batchLen > 0) {
      await writer.write(batch.subarray(0, batchLen))
    }

    await writer.close()
    log('下载完成')

    if (onSuccess) {
      onSuccess({ filename })
    }
  } catch (error) {
    log('下载失败: ' + error.message)
    if (onError) {
      onError(error)
    } else {
      throw error
    }
  }
}


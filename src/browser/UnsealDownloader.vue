<template>
  <div class="unseal-downloader">
    <slot
      :download="download"
      :isDownloading="isDownloading"
      :progress="progress"
      :error="error"
      :status="status"
    >
      <button
        :disabled="isDownloading || !canDownload"
        @click="download"
        class="download-btn"
      >
        {{ isDownloading ? '下载中...' : '下载并解密' }}
      </button>
      <div v-if="progress" class="progress-info">
        <div>总块数: {{ progress.total }}</div>
        <div>已处理: {{ progress.processed }}</div>
        <div>已读: {{ formatBytes(progress.readBytes) }}</div>
        <div>已写: {{ formatBytes(progress.writeBytes) }}</div>
      </div>
      <div v-if="error" class="error">{{ error }}</div>
    </slot>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { unsealStream } from './UnsealerBrowser.js'
import { prepareSealedResponse } from './SealedHttpTailHeaderTransform.js'

const props = defineProps({
  // 加密文件URL
  url: {
    type: String,
    required: true
  },
  // 私钥（hex格式）
  privateKey: {
    type: String,
    required: true
  },
  // 下载文件名
  filename: {
    type: String,
    default: 'unsealed.bin'
  },
  // 是否启用分块模式
  chunked: {
    type: Boolean,
    default: false
  },
  // 日志回调
  onLog: {
    type: Function,
    default: null
  },
})

const emit = defineEmits(['progress', 'success', 'error', 'start', 'complete'])

const isDownloading = ref(false)
const progress = ref(null)
const error = ref(null)
const status = ref('idle') // idle, downloading, success, error

const canDownload = computed(() => {
  return props.url && props.privateKey && !isDownloading.value
})

const log = (message) => {
  if (props.onLog) {
    props.onLog(message)
  } else {
    console.log(`[UnsealDownloader] ${message}`)
  }
}

const formatBytes = (bytes) => {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}


// Same constants as in SealedHttpTailHeaderTransform
const HEADER_SIZE = 64
const BLOCK_INFO_SIZE = 32
function readUint64LE(u8, off) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const lo = dv.getUint32(off, true)
  const hi = dv.getUint32(off + 4, true)
  return hi * 0x100000000 + lo
}

// Inspect sealed file by HEAD + Range(tail) to compute contentSize (plaintext total bytes)
async function inspectSealed(url) {
  // Prefer HEAD to get total size
  let totalSize = null
  try {
    const head = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    if (head.ok) {
      const lenStr = head.headers.get('Content-Length')
      if (lenStr) totalSize = Number(lenStr)
    }
  } catch (e) {
    /* ignore */
  }
  // Helper: parse total from Content-Range: bytes start-end/total
  const parseTotal = (cr) => {
    if (!cr) return null
    const m = /\/([0-9]+)$/.exec(cr)
    return m ? Number(m[1]) : null
  }
  // Try to get tail header and total via suffix range
  let headerBuf = null
  if (totalSize == null) {
    try {
      const tail = await fetch(url, {
        headers: { Range: `bytes=-${HEADER_SIZE}` },
        cache: 'no-store'
      })
      if (tail.status === 206) {
        const cr = tail.headers.get('Content-Range')
        totalSize = parseTotal(cr)
        headerBuf = new Uint8Array(await tail.arrayBuffer())
      }
    } catch (e) {
      /* ignore */
    }
  }
  // If still no total, try 0-0 probe then a tail fetch
  if (totalSize == null) {
    try {
      const lr = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store'
      })
      if (lr.status === 206) {
        totalSize = parseTotal(lr.headers.get('Content-Range'))
      }
    } catch (e) {
      /* ignore */
    }
  }
  if (totalSize == null) {
    return { totalSize: null, blockNumber: null, contentSize: null }
  }
  if (!Number.isFinite(totalSize) || totalSize < HEADER_SIZE) throw new Error('文件大小异常')
  // Ensure we have header bytes
  if (!headerBuf) {
    const start = totalSize - HEADER_SIZE
    const tail = await fetch(url, {
      headers: { Range: `bytes=${start}-${totalSize - 1}` },
      cache: 'no-store'
    })
    if (!(tail.status === 206 || tail.status === 200))
      throw new Error('Range 读取尾部 header 失败: ' + tail.status)
    headerBuf = new Uint8Array(await tail.arrayBuffer())
  }
  if (headerBuf.length !== HEADER_SIZE) {
    return { totalSize, blockNumber: null, contentSize: null }
  }
  const blockNumber = readUint64LE(headerBuf, 16)
  const contentSize = totalSize - HEADER_SIZE - BLOCK_INFO_SIZE * blockNumber
  if (contentSize <= 0) {
    return { totalSize, blockNumber, contentSize: null }
  }
  return { totalSize, blockNumber, contentSize }
}

// 直接从demo复制的函数，保持完全一致
async function withFileWriter(defaultName = 'unsealed.bin') {
  // Prefer File System Access API when available
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: defaultName,
      types: [{ description: 'Binary', accept: { 'application/octet-stream': ['.bin'] } }]
    })
    const writable = await handle.createWritable()
    return {
      async write(u8) {
        await writable.write(u8)
      },
      async close() {
        await writable.close()
      }
    }
  }
  // Fallback: accumulate to blob and trigger download at end
  const chunks = []
  return {
    async write(u8) {
      chunks.push(new Uint8Array(u8))
    },
    async close() {
      const total = chunks.reduce((a, b) => a + b.length, 0)
      const merged = new Uint8Array(total)
      let o = 0
      for (const c of chunks) {
        merged.set(c, o)
        o += c.length
      }
      const blob = new Blob([merged])
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = defaultName
      a.click()
    }
  }
}

// 下载写入器：完全按照demo的实现，自动尝试Service Worker，失败则回退
async function withNativeDownloadWriter(filename, expectedSize) {
  // 方案1: Service Worker（完全按照demo的实现）
  if ('serviceWorker' in navigator) {
    try {
      // 尝试多个可能的路径
      // 1. 如果用户将sw-download.js放到public目录（最常见）
      // 2. 如果构建工具自动复制了（通过vite.config.js配置）
      // 3. demo路径（兼容demo）
      const swPaths = [
        '/sw-download.js',  // 最常见：放到public根目录
        '/example/browser/sw-download.js',  // demo路径（兼容demo）
      ]
      
      let reg = null
      let swPath = null
      let scope = '/'
      
      // 尝试注册Service Worker（按优先级尝试）
      for (const pathStr of swPaths) {
        try {
          scope = pathStr.replace(/\/[^/]*$/, '/') || '/'
          reg = await navigator.serviceWorker.register(pathStr, { scope })
          swPath = pathStr
          log(`[Download] 注册 Service Worker: ${pathStr}, scope: ${scope}`)
          break  // 成功就退出
        } catch (e) {
          // 继续尝试下一个路径
          continue
        }
      }
      
      if (!reg) {
        throw new Error('无法注册 Service Worker，所有路径都失败')
      }
      
      // Wait for SW to be ready and controlling this page
      await navigator.serviceWorker.ready
      
      async function ensureController() {
        if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller
        // try to message active worker directly
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
      const size =
        typeof expectedSize === 'number' && isFinite(expectedSize) ? expectedSize : undefined
      
      // Post to the active/controller SW
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

      // 使用下载路径（Service Worker会拦截这个路径）
      // Service Worker支持 /download/unsealed 或 endsWith('/download/unsealed')
      const downloadUrl = `/download/unsealed?id=${encodeURIComponent(id)}`
      
      // Trigger native download in a new tab to keep current page streaming chunks
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
      
      log(`[Download] 使用同源 SW 原生下载，size=${size ?? '未知'}`)
      return {
        async write(u8) {
          // Always send a copy so the original (e.g., reusable batch buffer) is not detached
          const copy =
            u8 && u8.byteLength ? (u8.slice ? u8.slice() : new Uint8Array(u8)) : new Uint8Array()
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
  
  // 方案2: StreamSaver（如果可用，支持原生下载进度条）
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
  log('[Download] 回退到 File System Access/Blob')
  return withFileWriter(filename)
}

// 主下载函数
async function download() {
  if (!canDownload.value) {
    return
  }

  isDownloading.value = true
  error.value = null
  progress.value = null
  status.value = 'downloading'
  emit('start')

  try {
    const url = props.url.trim()
    const priv = props.privateKey.trim()

    if (!url || !priv) {
      throw new Error('请提供 URL 和私钥')
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
      chunked: props.chunked
    })

    if (!resp.ok) {
      throw new Error('HTTP 状态: ' + resp.status)
    }

    log('已连接，开始解密并写入文件...')

    // 创建下载写入器（直接使用demo的实现，自动选择最佳方案）
    const writer = await withNativeDownloadWriter(props.filename, expectedPlainBytes)

    // 批量写入缓冲区
    const BATCH_SIZE = 512 * 1024 // 512KB
    let batch = new Uint8Array(BATCH_SIZE)
    let batchLen = 0

    // 流式解密并保存
    await unsealStream(resp, {
      privateKeyHex: priv,
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
        progress.value = {
          total,
          processed,
          readBytes,
          writeBytes
        }
        emit('progress', progress.value)
      }
    })

    // 刷新剩余批次
    if (batchLen > 0) {
      await writer.write(batch.subarray(0, batchLen))
    }

    await writer.close()

    status.value = 'success'
    emit('success', { filename: props.filename })
    log('下载并解密完成')
  } catch (e) {
    error.value = e.message
    status.value = 'error'
    emit('error', e)
    log('下载失败: ' + e.message)
  } finally {
    isDownloading.value = false
    emit('complete', { status: status.value, error: error.value })
  }
}

defineExpose({
  download,
  isDownloading,
  progress,
  error,
  status
})
</script>

<style scoped>
.unseal-downloader {
  display: inline-block;
}

.download-btn {
  padding: 8px 16px;
  font-size: 14px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}

.download-btn:hover:not(:disabled) {
  background: #f5f5f5;
}

.download-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.progress-info {
  margin-top: 8px;
  font-size: 12px;
  color: #666;
}

.progress-info > div {
  margin: 4px 0;
}

.error {
  margin-top: 8px;
  color: #f56c6c;
  font-size: 12px;
}
</style>


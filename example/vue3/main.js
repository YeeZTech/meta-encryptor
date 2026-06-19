import { createApp } from 'vue'
import App from './App.vue'

// 确保 Buffer polyfill 存在（如果需要）
if (typeof window !== 'undefined' && !window.Buffer) {
  import('buffer').then(({ Buffer }) => {
    window.Buffer = Buffer
  })
}

// 配置 StreamSaver（可选）
if (window.streamSaver) {
  // StreamSaver v2 默认用 Service Worker，无需 mitm
  // mitm 只在无法使用 SW 的旧浏览器中需要
  try {
    window.streamSaver.mitm = 'https://jimmywarting.github.io/StreamSaver.js/mitm.html?version=2.0.6'
    // 允许 Blob 回退，避免 Service Worker 不可用时直接报错
    window.streamSaver.useBlobFallback = true
  } catch (e) {
    // ignore
  }
}

createApp(App).mount('#app')


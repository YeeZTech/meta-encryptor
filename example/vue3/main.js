import { createApp } from 'vue'
import App from './App.vue'

// 确保 Buffer polyfill 存在（如果需要）
if (typeof window !== 'undefined' && !window.Buffer) {
  import('buffer').then(({ Buffer }) => {
    window.Buffer = Buffer
  })
}

// 可选：配置 StreamSaver（如果需要）
if (window.streamSaver) {
  window.streamSaver.mitm = 'https://jimmywarting.github.io/StreamSaver.js/mitm.html?version=2.0.6'
  try {
    window.streamSaver.useBlobFallback = false
  } catch (e) {
    // ignore
  }
}

createApp(App).mount('#app')


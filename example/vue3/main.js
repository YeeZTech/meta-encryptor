import { createApp } from 'vue'
import App from './App.vue'

// 确保 Buffer polyfill 存在（如果需要）
if (typeof window !== 'undefined' && !window.Buffer) {
  import('buffer').then(({ Buffer }) => {
    window.Buffer = Buffer
  })
}

createApp(App).mount('#app')

createApp(App).mount('#app')


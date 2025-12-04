import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { copyFileSync, existsSync } from 'fs'

// 自动从node_modules复制Service Worker文件到public目录
// 这样用户无需手动复制，构建时会自动处理
function copyServiceWorker() {
  // 优先尝试从node_modules（npm包）复制
  const swSourceFromNpm = resolve(__dirname, '../../node_modules/@yeez-tech/meta-encryptor/src/browser/sw-download.js')
  // 回退到本地源码路径（开发时）
  const swSourceFromLocal = resolve(__dirname, '../../src/browser/sw-download.js')
  const swDest = resolve(__dirname, './public/sw-download.js')
  
  let swSource = null
  if (existsSync(swSourceFromNpm)) {
    swSource = swSourceFromNpm
  } else if (existsSync(swSourceFromLocal)) {
    swSource = swSourceFromLocal
  }
  
  if (swSource && !existsSync(swDest)) {
    copyFileSync(swSource, swDest)
    console.log('[Vite] 已自动复制 Service Worker 文件到 public 目录')
  }
}

copyServiceWorker()

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, '../../src')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/example': {
        target: 'http://localhost:8088',
        changeOrigin: true
      }
    }
  },
  optimizeDeps: {
    include: ['buffer']
  }
})


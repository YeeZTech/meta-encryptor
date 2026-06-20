import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { copyFileSync, existsSync } from 'fs'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, '../../src'),
      '@yeez-tech/meta-encryptor': resolve(__dirname, '../../')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/example': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  },
  optimizeDeps: {
    include: ['buffer']
  }
})


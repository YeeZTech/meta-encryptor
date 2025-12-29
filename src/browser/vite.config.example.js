// Vite 配置示例：自动复制 Service Worker 文件
// 将以下代码添加到你的 vite.config.js 中

import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'

// 自动从node_modules复制Service Worker文件到public目录
function copyServiceWorker() {
  // 从npm包的build目录中复制（sw-download.js会被构建到build/browser/）
  const swSourceFromNpm = resolve(__dirname, 'node_modules/@yeez-tech/meta-encryptor/build/browser/sw-download.js')
  const swDest = resolve(__dirname, './public/sw-download.js')
  const publicDir = resolve(__dirname, './public')
  
  if (existsSync(swSourceFromNpm)) {
    // 确保 public 目录存在
    if (!existsSync(publicDir)) {
      mkdirSync(publicDir, { recursive: true })
    }
    copyFileSync(swSourceFromNpm, swDest)
    console.log('[Vite] 已自动复制 Service Worker 文件到 public 目录')
  } else {
    console.warn('[Vite] Service Worker 文件未找到，请确保已安装 @yeez-tech/meta-encryptor 并运行了构建')
  }
}

// 在导出配置前调用
copyServiceWorker()

export default defineConfig({
})


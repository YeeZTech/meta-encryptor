import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'

function copyServiceWorker() {
  const swSourceFromNpm = resolve(__dirname, 'node_modules/@yeez-tech/meta-encryptor/build/browser/sw-download.js')
  const swDest = resolve(__dirname, './public/sw-download.js')
  const publicDir = resolve(__dirname, './public')
  
  if (existsSync(swSourceFromNpm)) {
    if (!existsSync(publicDir)) {
      mkdirSync(publicDir, { recursive: true })
    }
    copyFileSync(swSourceFromNpm, swDest)
    console.log('[Vite] Service Worker copied to public directory')
  } else {
    console.warn('[Vite] Service Worker not found. Ensure @yeez-tech/meta-encryptor is installed and built.')
  }
}

copyServiceWorker()

export default defineConfig({
})


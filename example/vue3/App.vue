<template>
  <div class="app">
    <h1>Meta-Encryptor Vue3 组件示例</h1>
    
    <div class="form-section">
      <h2>配置参数</h2>
      <div class="form-item">
        <label>加密文件 URL:</label>
        <input v-model="url" type="text" placeholder="例如: http://localhost:8088/example/browser/sealed_full.bin" />
      </div>
      <div class="form-item">
        <label>私钥 (hex):</label>
        <input v-model="privateKey" type="text" placeholder="64字节十六进制" />
      </div>
      <div class="form-item">
        <label>下载文件名:</label>
        <input v-model="filename" type="text" placeholder="unsealed.bin" />
      </div>
    </div>

    <div class="component-section">
      <h2>组件使用</h2>
      
      <!-- 方式1: 使用默认插槽 -->
      <UnsealDownloader
        :url="url"
        :private-key="privateKey"
        :filename="filename"
        :on-log="handleLog"
        @start="handleStart"
        @progress="handleProgress"
        @success="handleSuccess"
        @error="handleError"
        @complete="handleComplete"
      />

      <!-- 方式2: 使用自定义插槽 -->
      <div class="custom-wrapper">
        <h3>自定义按钮样式</h3>
        <UnsealDownloader
          :url="url"
          :private-key="privateKey"
          :filename="filename"
          :on-log="handleLog"
          @start="handleStart"
          @progress="handleProgress"
          @success="handleSuccess"
          @error="handleError"
          @complete="handleComplete"
        >
          <template #default="{ download, isDownloading, progress, error }">
            <button
              @click="download"
              :disabled="isDownloading || !url || !privateKey"
              class="custom-btn"
            >
              {{ isDownloading ? '⏳ 下载中...' : '⬇️ 开始下载' }}
            </button>
            <div v-if="progress" class="custom-progress">
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  :style="{ width: `${(progress.processed / progress.total) * 100}%` }"
                ></div>
              </div>
              <div class="progress-text">
                进度: {{ progress.processed }} / {{ progress.total }} 块
                ({{ formatBytes(progress.writeBytes) }})
              </div>
            </div>
            <div v-if="error" class="custom-error">❌ {{ error }}</div>
          </template>
        </UnsealDownloader>
      </div>

      <!-- 方式3: 使用 ref 调用方法 -->
      <div class="ref-wrapper">
        <h3>通过 ref 调用</h3>
        <UnsealDownloader
          ref="downloaderRef"
          :url="url"
          :private-key="privateKey"
          :filename="filename"
          :on-log="handleLog"
          @start="handleStart"
          @progress="handleProgress"
          @success="handleSuccess"
          @error="handleError"
          @complete="handleComplete"
        />
        <button @click="downloadViaRef" :disabled="!url || !privateKey" class="ref-btn">
          通过 ref 下载
        </button>
        <div v-if="refStatus" class="ref-status">
          状态: {{ refStatus }}
        </div>
      </div>
    </div>

    <div class="log-section">
      <h2>日志</h2>
      <div class="log-container">
        <div v-for="(log, index) in logs" :key="index" class="log-item">
          {{ log }}
        </div>
      </div>
      <button @click="clearLogs" class="clear-btn">清除日志</button>
    </div>

    <div class="status-section">
      <h2>状态信息</h2>
      <div class="status-item">
        <strong>最后事件:</strong> {{ lastEvent }}
      </div>
      <div class="status-item" v-if="lastProgress">
        <strong>进度:</strong>
        <ul>
          <li>总块数: {{ lastProgress.total }}</li>
          <li>已处理: {{ lastProgress.processed }}</li>
          <li>已读: {{ formatBytes(lastProgress.readBytes) }}</li>
          <li>已写: {{ formatBytes(lastProgress.writeBytes) }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import UnsealDownloader from '@/browser/UnsealDownloader.vue'

const url = ref('http://localhost:8088/example/browser/sealed_full.bin')
const privateKey = ref('')
const filename = ref('unsealed.bin')

const logs = ref([])
const lastEvent = ref('')
const lastProgress = ref(null)
const refStatus = ref('')
const downloaderRef = ref(null)

const formatBytes = (bytes) => {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
}

const handleLog = (message) => {
  const timestamp = new Date().toLocaleTimeString()
  logs.value.push(`[${timestamp}] ${message}`)
  console.log(message)
}

const handleStart = () => {
  lastEvent.value = '开始下载'
  handleLog('下载开始')
}

const handleProgress = (progressData) => {
  lastProgress.value = progressData
  lastEvent.value = '进度更新'
}

const handleSuccess = (data) => {
  lastEvent.value = `下载成功: ${data.filename}`
  handleLog(`下载成功: ${data.filename}`)
}

const handleError = (error) => {
  lastEvent.value = `下载失败: ${error.message}`
  handleLog(`下载失败: ${error.message}`)
}

const handleComplete = (data) => {
  lastEvent.value = `下载完成: ${data.status}`
  handleLog(`下载完成: ${data.status}`)
}

const clearLogs = () => {
  logs.value = []
}

const downloadViaRef = async () => {
  if (!downloaderRef.value) return
  try {
    await downloaderRef.value.download()
    refStatus.value = '下载已触发'
  } catch (e) {
    refStatus.value = `错误: ${e.message}`
  }
}

// 自动加载私钥（如果可用）
async function loadKeys() {
  try {
    const base = window.location.origin
    const r = await fetch(`${base}/example/browser/keys.json`, { cache: 'no-store' })
    if (r.ok) {
      const j = await r.json()
      if (j?.private_key) {
        privateKey.value = j.private_key
        handleLog('已自动加载私钥')
      }
    }
  } catch (e) {
    // ignore
  }
}

loadKeys()
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  background: #f5f5f5;
}

.app {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
}

h1 {
  margin-bottom: 30px;
  color: #333;
}

h2 {
  margin: 20px 0 15px;
  color: #555;
  font-size: 18px;
}

h3 {
  margin: 15px 0 10px;
  color: #666;
  font-size: 16px;
}

.form-section,
.component-section,
.log-section,
.status-section {
  background: white;
  padding: 20px;
  margin-bottom: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.form-item {
  margin-bottom: 15px;
}

.form-item label {
  display: block;
  margin-bottom: 5px;
  font-weight: 500;
  color: #333;
}

.form-item input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}

.form-item input:focus {
  outline: none;
  border-color: #409eff;
}

.custom-wrapper,
.ref-wrapper {
  margin-top: 20px;
  padding: 15px;
  background: #f9f9f9;
  border-radius: 4px;
}

.custom-btn {
  padding: 10px 20px;
  font-size: 16px;
  border: none;
  border-radius: 6px;
  background: #409eff;
  color: white;
  cursor: pointer;
  transition: background 0.3s;
}

.custom-btn:hover:not(:disabled) {
  background: #66b1ff;
}

.custom-btn:disabled {
  background: #c0c4cc;
  cursor: not-allowed;
}

.custom-progress {
  margin-top: 15px;
}

.progress-bar {
  width: 100%;
  height: 20px;
  background: #e4e7ed;
  border-radius: 10px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #409eff;
  transition: width 0.3s;
}

.progress-text {
  margin-top: 5px;
  font-size: 12px;
  color: #666;
}

.custom-error {
  margin-top: 10px;
  padding: 8px;
  background: #fef0f0;
  color: #f56c6c;
  border-radius: 4px;
  font-size: 14px;
}

.ref-btn {
  padding: 8px 16px;
  font-size: 14px;
  border: 1px solid #409eff;
  border-radius: 4px;
  background: white;
  color: #409eff;
  cursor: pointer;
}

.ref-btn:hover:not(:disabled) {
  background: #ecf5ff;
}

.ref-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ref-status {
  margin-top: 10px;
  font-size: 14px;
  color: #666;
}

.log-container {
  max-height: 300px;
  overflow-y: auto;
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 15px;
  border-radius: 4px;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  margin-bottom: 10px;
}

.log-item {
  margin-bottom: 5px;
  line-height: 1.5;
}

.clear-btn {
  padding: 6px 12px;
  font-size: 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  cursor: pointer;
}

.clear-btn:hover {
  background: #f5f5f5;
}

.status-section {
  background: #f0f9ff;
}

.status-item {
  margin-bottom: 10px;
}

.status-item strong {
  color: #333;
}

.status-item ul {
  margin-left: 20px;
  margin-top: 5px;
}

.status-item li {
  margin-bottom: 5px;
  color: #666;
}
</style>


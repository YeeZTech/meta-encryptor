<template>
  <div class="unseal-downloader">
    <slot
      :download="download"
      :is-downloading="isDownloading"
      :progress="progress"
      :error="error"
      :status="status"
    >
      <button
        type="button"
        class="default-btn"
        :disabled="isDownloading || !url || !privateKey"
        @click="download"
      >
        {{ isDownloading ? '下载中...' : '下载并解密' }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>
    </slot>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { downloadUnsealed } from '@yeez-tech/meta-encryptor'

const props = defineProps({
  url: { type: String, required: true },
  privateKey: { type: String, required: true },
  filename: { type: String, default: 'unsealed.bin' },
  onLog: { type: Function, default: null },
})

const emit = defineEmits(['start', 'progress', 'success', 'error', 'complete'])

const isDownloading = ref(false)
const progress = ref(null)
const error = ref(null)
const status = ref('idle')

async function download() {
  if (isDownloading.value || !props.url || !props.privateKey) return

  isDownloading.value = true
  status.value = 'downloading'
  error.value = null
  emit('start')

  try {
    await downloadUnsealed({
      url: props.url,
      privateKey: props.privateKey,
      filename: props.filename,
      onLog: props.onLog || undefined,
      onProgress: (total, processed, readBytes, writeBytes) => {
        progress.value = { total, processed, readBytes, writeBytes }
        emit('progress', progress.value)
      },
      onSuccess: (data) => {
        status.value = 'success'
        emit('success', data)
        emit('complete', { status: 'success', ...data })
      },
      onError: (err) => {
        error.value = err.message
        status.value = 'error'
        emit('error', err)
        emit('complete', { status: 'error', error: err })
      },
    })
  } catch (err) {
    error.value = err.message
    status.value = 'error'
    emit('error', err)
    emit('complete', { status: 'error', error: err })
  } finally {
    isDownloading.value = false
  }
}

defineExpose({ download, isDownloading, progress, error, status })
</script>

<style scoped>
.default-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: #409eff;
  color: #fff;
  cursor: pointer;
}
.default-btn:disabled {
  background: #c0c4cc;
  cursor: not-allowed;
}
.error {
  margin-top: 8px;
  color: #f56c6c;
  font-size: 14px;
}
</style>

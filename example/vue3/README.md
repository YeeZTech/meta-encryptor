# Meta-Encryptor Vue3 组件示例

这是一个使用 Vue3 组件封装边下载边解密功能的示例项目。

## 安装依赖

```bash
cd example/vue3
npm install
# 或
yarn install
```

## 启动开发服务器

首先确保后端服务器正在运行：

```bash
# 在项目根目录
yarn serve:example
```

然后启动 Vue3 示例：

```bash
cd example/vue3
npm run dev
```

访问 http://localhost:5173

## 组件使用

### 基本用法

```vue
<template>
  <UnsealDownloader
    :url="encryptedFileUrl"
    :private-key="privateKey"
    :filename="'decrypted.bin'"
    @success="handleSuccess"
    @error="handleError"
  />
</template>

<script setup>
import UnsealDownloader from '@/browser/UnsealDownloader.vue'

const encryptedFileUrl = 'http://localhost:8088/example/browser/sealed_full.bin'
const privateKey = 'your-private-key-hex'

const handleSuccess = (data) => {
  console.log('下载成功:', data.filename)
}

const handleError = (error) => {
  console.error('下载失败:', error)
}
</script>
```

### 使用自定义插槽

```vue
<template>
  <UnsealDownloader
    :url="encryptedFileUrl"
    :private-key="privateKey"
  >
    <template #default="{ download, isDownloading, progress, error }">
      <button @click="download" :disabled="isDownloading">
        {{ isDownloading ? '下载中...' : '开始下载' }}
      </button>
      <div v-if="progress">
        进度: {{ progress.processed }} / {{ progress.total }}
      </div>
      <div v-if="error" class="error">{{ error }}</div>
    </template>
  </UnsealDownloader>
</template>
```

### 通过 ref 调用

```vue
<template>
  <UnsealDownloader
    ref="downloader"
    :url="encryptedFileUrl"
    :private-key="privateKey"
  />
  <button @click="handleDownload">下载</button>
</template>

<script setup>
import { ref } from 'vue'
import UnsealDownloader from '@/browser/UnsealDownloader.vue'

const downloader = ref(null)

const handleDownload = async () => {
  await downloader.value.download()
}
</script>
```

## Props

| 属性 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| url | String | 是 | - | 加密文件的URL |
| privateKey | String | 是 | - | 私钥（hex格式） |
| filename | String | 否 | 'unsealed.bin' | 下载文件名 |
| serviceWorkerPath | String | 否 | null | Service Worker路径（用于原生下载进度） |
| serviceWorkerScope | String | 否 | null | Service Worker作用域 |
| chunked | Boolean | 否 | false | 是否启用分块模式 |
| onLog | Function | 否 | null | 日志回调函数 |

## Events

| 事件名 | 参数 | 说明 |
|--------|------|------|
| start | - | 下载开始 |
| progress | progress | 进度更新（包含 total, processed, readBytes, writeBytes） |
| success | data | 下载成功（包含 filename） |
| error | error | 下载失败（包含错误信息） |
| complete | data | 下载完成（包含 status 和 error） |

## 插槽

| 插槽名 | 作用域 | 说明 |
|--------|--------|------|
| default | { download, isDownloading, progress, error, status } | 自定义组件内容 |

## 暴露的方法

通过 ref 可以调用以下方法：

- `download()`: 触发下载

## 暴露的状态

- `isDownloading`: 是否正在下载
- `progress`: 进度信息
- `error`: 错误信息
- `status`: 状态（idle, downloading, success, error）


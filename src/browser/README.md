# Meta-Encryptor 浏览器端命令式 API

## 快速开始

```javascript
import { downloadUnsealed } from "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js";

// 基本使用
await downloadUnsealed({
  url: "http://example.com/encrypted.bin",
  privateKey: "your-private-key-hex-64-bytes",
  filename: "decrypted.bin",
});
```

## 安装

```bash
npm install @yeez-tech/meta-encryptor
```

## API 文档

### downloadUnsealed(options)

下载并解密加密文件。

#### 参数

| 参数         | 类型     | 必填 | 说明                                                         |
| ------------ | -------- | ---- | ------------------------------------------------------------ |
| `url`        | string   | ✅   | 加密文件的 URL（必须支持 HTTP Range 请求）                   |
| `privateKey` | string   | ✅   | 私钥（hex 格式，64 字节）                                    |
| `filename`   | string   | ✅   | 下载文件名（必需，无默认值）                                 |
| `onLog`      | function | ❌   | 日志回调 `(message: string) => void`                         |
| `onProgress` | function | ❌   | 进度回调 `(total, processed, readBytes, writeBytes) => void` |
| `onSuccess`  | function | ❌   | 成功回调 `(data: { filename }) => void`                      |
| `onError`    | function | ❌   | 错误回调 `(error: Error) => void`                            |

#### 返回值

`Promise<void>` - 如果提供了 `onError`，错误会被回调处理；否则会抛出异常。

#### 注意事项

- **文件名必需**：`filename` 参数是必需的，没有默认值
- **私钥格式**：必须是 64 字节的十六进制字符串（128 个字符）
- **URL 要求**：必须支持 HTTP Range 请求（用于读取文件头部和分块下载）
- **浏览器环境**：此 API 只能在浏览器环境中使用，不支持 Node.js 或 SSR 服务端渲染

## 使用示例

### 示例 1：基本使用

```javascript
import { downloadUnsealed } from "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js";

button.addEventListener("click", async () => {
  try {
    await downloadUnsealed({
      url: "http://example.com/encrypted.bin",
      privateKey:
        "b574dbe4a665c8186102454aef49deb1f213a37c28b083d2d8995db10f7dcadc",
      filename: "decrypted.bin",
    });
    console.log("下载完成");
  } catch (error) {
    console.error("下载失败:", error);
  }
});
```

### 示例 2：完整回调

```javascript
import { downloadUnsealed } from "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js";

await downloadUnsealed({
  url: "http://example.com/encrypted.bin",
  privateKey: "your-private-key-hex",
  filename: "decrypted.bin",
  onLog: (message) => {
    console.log("[Download]", message);
  },
  onProgress: (total, processed, readBytes, writeBytes) => {
    console.log(`进度: ${processed}/${total} 块`);
    console.log(`已读: ${readBytes} 字节`);
    console.log(`已写: ${writeBytes} 字节`);
  },
  onSuccess: (data) => {
    console.log("下载成功:", data.filename);
    alert("下载完成！");
  },
  onError: (error) => {
    console.error("下载失败:", error.message);
    alert("下载失败: " + error.message);
  },
});
```

### 示例 3：Vue3 中使用

```vue
<template>
  <button @click="handleDownload" :disabled="isDownloading">
    {{ isDownloading ? "下载中..." : "下载" }}
  </button>
</template>

<script setup>
import { ref } from "vue";
import { downloadUnsealed } from "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js";

const isDownloading = ref(false);

const handleDownload = async () => {
  isDownloading.value = true;
  try {
    await downloadUnsealed({
      url: "http://example.com/encrypted.bin",
      privateKey: "your-private-key-hex",
      filename: "decrypted.bin",
      onProgress: (total, processed, readBytes, writeBytes) => {
        console.log(`进度: ${processed}/${total} 块`);
        console.log(`已读: ${readBytes} 字节，已写: ${writeBytes} 字节`);
      },
    });
  } catch (error) {
    console.error("下载失败:", error);
  } finally {
    isDownloading.value = false;
  }
};
</script>
```

### 示例 4：React 中使用

```jsx
import { useState } from "react";
import { downloadUnsealed } from "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js";

function DownloadButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      await downloadUnsealed({
        url: "http://example.com/encrypted.bin",
        privateKey: "your-private-key-hex",
        filename: "decrypted.bin",
        onProgress: (total, processed, readBytes, writeBytes) => {
          console.log(`进度: ${processed}/${total} 块`);
          console.log(`已读: ${readBytes} 字节，已写: ${writeBytes} 字节`);
        },
      });
    } catch (error) {
      console.error("下载失败:", error);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <button onClick={handleDownload} disabled={isDownloading}>
      {isDownloading ? "下载中..." : "下载"}
    </button>
  );
}
```

## SSR 支持

此 API **仅支持浏览器环境**，不支持 Node.js 或 SSR 服务端渲染。在 SSR 项目中使用时，需要：

### 推荐方案：弹窗 + 动态导入（最安全）

**最佳实践**：在弹窗的点击事件中动态导入组件，确保代码只在客户端执行。

#### Next.js 示例

```javascript
"use client"; // Next.js 13+ App Router

import { useState } from "react";

function DownloadPage() {
  const [showModal, setShowModal] = useState(false);

  // 第一步：点击下载按钮，显示弹窗
  const handleOpenModal = () => {
    setShowModal(true);
  };

  // 第二步：在弹窗内点击确认，动态导入并执行下载
  const handleConfirmDownload = async () => {
    try {
      // 动态导入，确保只在客户端执行
      const { downloadUnsealed } = await import(
        "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js"
      );

      await downloadUnsealed({
        url: "http://example.com/encrypted.bin",
        privateKey: "your-private-key-hex",
        filename: "decrypted.bin",
        onProgress: (total, processed, readBytes, writeBytes) => {
          console.log(`进度: ${processed}/${total} 块`);
        },
        onSuccess: () => {
          setShowModal(false);
          alert("下载完成！");
        },
        onError: (error) => {
          alert("下载失败: " + error.message);
        },
      });
    } catch (error) {
      console.error("下载失败:", error);
      alert("下载失败: " + error.message);
    }
  };

  return (
    <div>
      <button onClick={handleOpenModal}>下载文件</button>

      {showModal && (
        <div className="modal">
          <div className="modal-content">
            <h3>确认下载</h3>
            <p>点击确认开始下载并解密文件</p>
            <button onClick={handleConfirmDownload}>确认下载</button>
            <button onClick={() => setShowModal(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

#### Nuxt.js 示例

```vue
<template>
  <div>
    <button @click="showModal = true">下载文件</button>

    <div v-if="showModal" class="modal">
      <div class="modal-content">
        <h3>确认下载</h3>
        <p>点击确认开始下载并解密文件</p>
        <button @click="handleConfirmDownload">确认下载</button>
        <button @click="showModal = false">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";

const showModal = ref(false);

// 在弹窗内点击确认，动态导入并执行下载
const handleConfirmDownload = async () => {
  try {
    // 动态导入，确保只在客户端执行
    const { downloadUnsealed } = await import(
      "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js"
    );

    await downloadUnsealed({
      url: "http://example.com/encrypted.bin",
      privateKey: "your-private-key-hex",
      filename: "decrypted.bin",
      onSuccess: () => {
        showModal.value = false;
        alert("下载完成！");
      },
      onError: (error) => {
        alert("下载失败: " + error.message);
      },
    });
  } catch (error) {
    console.error("下载失败:", error);
    alert("下载失败: " + error.message);
  }
};
</script>
```

#### 原生 JavaScript 示例

```html
<!DOCTYPE html>
<html>
  <head>
    <title>下载示例</title>
  </head>
  <body>
    <button id="downloadBtn">下载文件</button>

    <div id="modal" style="display: none;">
      <div class="modal-content">
        <h3>确认下载</h3>
        <p>点击确认开始下载并解密文件</p>
        <button id="confirmBtn">确认下载</button>
        <button id="cancelBtn">取消</button>
      </div>
    </div>

    <script type="module">
      const downloadBtn = document.getElementById("downloadBtn");
      const modal = document.getElementById("modal");
      const confirmBtn = document.getElementById("confirmBtn");
      const cancelBtn = document.getElementById("cancelBtn");

      // 第一步：点击下载按钮，显示弹窗
      downloadBtn.addEventListener("click", () => {
        modal.style.display = "block";
      });

      // 第二步：在弹窗内点击确认，动态导入并执行下载
      confirmBtn.addEventListener("click", async () => {
        try {
          // 动态导入，确保只在客户端执行
          const { downloadUnsealed } = await import(
            "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js"
          );

          await downloadUnsealed({
            url: "http://example.com/encrypted.bin",
            privateKey: "your-private-key-hex",
            filename: "decrypted.bin",
            onSuccess: () => {
              modal.style.display = "none";
              alert("下载完成！");
            },
            onError: (error) => {
              alert("下载失败: " + error.message);
            },
          });
        } catch (error) {
          console.error("下载失败:", error);
          alert("下载失败: " + error.message);
        }
      });

      cancelBtn.addEventListener("click", () => {
        modal.style.display = "none";
      });
    </script>
  </body>
</html>
```

### 其他 SSR 方案

#### Next.js 客户端组件

```javascript
"use client"; // Next.js 13+ App Router

import { useEffect, useState } from "react";

function DownloadButton() {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  const handleDownload = async () => {
    if (!isClient) return;

    // 动态导入，确保只在客户端执行
    const { downloadUnsealed } = await import(
      "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js"
    );

    await downloadUnsealed({
      url: "http://example.com/encrypted.bin",
      privateKey: "your-private-key-hex",
      filename: "decrypted.bin",
    });
  };

  if (!isClient) return null;

  return <button onClick={handleDownload}>下载</button>;
}
```

#### Nuxt.js 客户端检查

```vue
<template>
  <button @click="handleDownload" :disabled="!isClient">下载</button>
</template>

<script setup>
import { ref, onMounted } from "vue";

const isClient = ref(false);

onMounted(() => {
  isClient.value = true;
});

const handleDownload = async () => {
  if (!isClient.value) return;

  // 动态导入，确保只在客户端执行
  const { downloadUnsealed } = await import(
    "@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js"
  );

  await downloadUnsealed({
    url: "http://example.com/encrypted.bin",
    privateKey: "your-private-key-hex",
    filename: "decrypted.bin",
  });
};
</script>
```

### SSR 使用要点

1. **必须使用动态导入**：`await import('@yeez-tech/meta-encryptor/src/browser/downloadUnsealed.js')`
2. **在客户端事件中调用**：确保在用户交互事件（如点击）中执行，而不是在组件渲染时
3. **推荐弹窗方案**：在弹窗的确认按钮中动态导入，最安全可靠
4. **Next.js 使用 `'use client'`**：确保组件标记为客户端组件
5. **Nuxt.js 使用 `onMounted`**：确保在客户端生命周期中调用
6. **依赖兼容性**：`aes-js` 导入已修复，兼容 SSR 环境（Nuxt/Vite/Next.js）

## 下载方案

API 会自动选择最佳下载方案（按优先级）：

1. **Service Worker**（优先）- 原生下载进度条，需要配置 Service Worker 文件
2. **StreamSaver**（回退）- 需要引入 StreamSaver 库（可选）
3. **Blob 下载**（最终回退）- 内存占用较大，但兼容性最好

### 配置 Service Worker（可选，推荐）

为了使用 Service Worker 方案（最佳体验），需要将 `sw-download.js` 复制到项目的 `public` 目录。

#### Vite 配置示例

```javascript
// vite.config.js
import { resolve } from "path";
import { copyFileSync, existsSync, mkdirSync } from "fs";

function copyServiceWorker() {
  const swSource = resolve(
    __dirname,
    "node_modules/@yeez-tech/meta-encryptor/src/browser/sw-download.js"
  );
  const swDest = resolve(__dirname, "./public/sw-download.js");
  const publicDir = resolve(__dirname, "./public");

  if (existsSync(swSource)) {
    if (!existsSync(publicDir)) {
      mkdirSync(publicDir, { recursive: true });
    }
    copyFileSync(swSource, swDest);
    console.log("[Vite] 已自动复制 Service Worker 文件到 public 目录");
  }
}

// 在构建时复制
export default {
  // ... 其他配置
  plugins: [
    // ... 其他插件
    {
      name: "copy-service-worker",
      buildStart() {
        copyServiceWorker();
      },
    },
  ],
};
```

#### 手动复制

```bash
# 复制 Service Worker 文件到 public 目录
cp node_modules/@yeez-tech/meta-encryptor/src/browser/sw-download.js public/sw-download.js
```

## 浏览器兼容性

- ✅ Chrome/Edge 88+
- ✅ Firefox 78+
- ✅ Safari 14+
- ✅ 支持 `fetch` API 和 `ReadableStream` 的现代浏览器

## 常见问题

### 1. Service Worker 注册失败

如果看到 `[Download] 注册/使用同源 SW 失败`，请确保：

- `sw-download.js` 已复制到 `public` 目录
- 文件可以通过 HTTP 访问（如 `http://localhost:5173/sw-download.js`）
- 浏览器支持 Service Worker（HTTPS 或 localhost）

### 2. 下载到默认目录

下载路径由浏览器控制，无法通过 API 配置。文件会保存到浏览器的默认下载目录。

### 3. 大文件内存占用

对于大文件，建议使用 Service Worker 方案（方案 1），它支持流式下载，内存占用最小。

### 4. SSR 项目报错

确保在客户端环境中使用，参考上面的 [SSR 支持](#ssr-支持) 部分。

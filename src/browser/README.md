# Meta-Encryptor 浏览器 API

## 安装与导入

```bash
npm install @yeez-tech/meta-encryptor
```

```js
import {
  downloadUnsealed,
  MetaEncryptorError,
} from '@yeez-tech/meta-encryptor/browser';
```

不要导入包内的 `src/` 文件；它们不属于公开发布接口。

## 下载并解密

```js
const abort = new AbortController();

await downloadUnsealed({
  url,
  privateKey,
  filename: 'decrypted.bin',
  signal: abort.signal,
  onProgress(totalItems, processedItems, readBytes, writeBytes) {
    console.log({ totalItems, processedItems, readBytes, writeBytes });
  },
  onByteProgress(estimatedTotalBytes, receivedBytes) {
    console.log({ estimatedTotalBytes, receivedBytes });
  },
});
```

`onProgress` 始终使用 item/解密字节语义；下载字节进度由独立的
`onByteProgress` 提供，两者不会混合调用。

## 输出策略

库按以下顺序选择输出：

1. 调用方通过 `streamSaver` 传入的可信 StreamSaver 实例；
2. 页面已经安装的 `window.streamSaver`；
3. File System Access API；
4. Blob 下载。

库不会从 CDN 注入脚本，也不会自动配置第三方 MITM 页面。如需
StreamSaver，请由应用打包并自行托管其配套资源：

```js
await downloadUnsealed({
  url,
  privateKey,
  filename,
  streamSaver: trustedStreamSaver,
});
```

用户取消保存、密钥错误、文件损坏、网络错误或已经开始写入后的失败都会直接
抛出，不会自动发起第二次 Blob 下载。

## HTTP 要求

- 服务必须提供准确的 `Content-Length`，并以 `206` 响应单段 Range 请求；
- 跨域下载默认只发送 CORS safelisted 的 `Range` 请求头，不发送会强制 OPTIONS
  预检的 `If-Range`；服务仍需返回允许当前页面读取响应的 CORS 头；
- 建议跨域服务设置
  `Access-Control-Expose-Headers: Content-Range, ETag, Last-Modified`。这些响应头
  对 JavaScript 可见时，库会严格校验请求区间、实体大小和实体标识；
- 未暴露上述响应头时，库会兼容普通 CORS 配置，同时要求每段响应具有精确字节数，
  并在解密完成前验证 sealed 文件声明的最终数据哈希；
- consumer 默认将单个 sealed item 限制为 64 MiB。恢复旧版生产者生成的更大单 item
  时，可显式传入更高的 `maxSealedItemSize`；该值会直接影响解密峰值内存；
- 重定向后的最终 URL 会被固定用于后续 Range 请求；
- 可通过 `fetch` 注入自定义实现，通过 `signal` 取消整个操作。

## 错误处理

```js
try {
  await downloadUnsealed({ url, privateKey, filename });
} catch (error) {
  if (error instanceof MetaEncryptorError) {
    console.error(error.code, error.localizedMessage, error.detail);
  }
}
```

如果传入 `onError`，错误会交给该回调；否则 Promise 会 reject。

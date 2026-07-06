---
"@yeez-tech/meta-encryptor": patch
---

修复下载/解密卡死与静默截断问题：

- **浏览器流式下载卡 99%（主因）**：`inspectSealed` 的明文大小是高估值（漏算 nt-package 封装开销），
  之前作为 `Content-Length` 传给 StreamSaver，导致浏览器下载永远到不了声明大小。现在不再向
  `createWriteStream` 声明 size；该值更名为 `plaintextSizeEstimate`（保留 `plaintextSize` 别名），
  仅用于大小限制与进度估算。进度 transformer 中间值钳制在 99% 以下，流真正完成时在 `flush()`
  补发最终 `onProgress(total, total)`。
- **解密失败静默跳过**：`UnsealerCore` 解密结果为空/过短时原来 `continue`（不计数、不报错），导致
  `finished` 永远为假、输出被静默截断。现在抛出 `ERR_DECRYPT_FAILED`。
- **Node Unsealer 流终止**：不再在 `_transform` 内 `push(null)`（消除 push-after-EOF 风险）；
  `_flush` 检测截断输入（新会话中 `totalItems>0 && !finished` → `ERR_TRUNCATED_INPUT`；续传会话宽松处理）。
  浏览器 `Unsealer` 的 `flush()` 同样检测截断。
- **Recoverable 流挂起**：`RecoverableReadStream` 在输入结束于任意状态时都能正确终止（含 header
  阶段 EOF 报错、防止 `once('readable')` 叠加）；`RecoverableWriteStream._final` 在内部流已
  finish/destroy 时不再永久等待，并补充 `_destroy`；已提交 item 数现在持久化到 context
  （`readItemCount`），续传时正确恢复。
- **HttpSealedFileStream 背压**：重写为 pull-based（每次 pull 拉取一个 Range 分片），所有 await
  进入 try/catch，支持 `signal`（AbortSignal），Range 使用重定向后的 URL，分片长度校验。
- **停滞看门狗**：`downloadUnsealed`/`streamDownloadAndDecrypt`/`blobDownloadAndDecrypt` 新增
  不活动看门狗（默认 60s 无数据中止，`timeoutMs` 可配置，0 禁用），流式尝试挂起时能真正触发
  Blob 降级而不是永久挂起；StreamSaver CDN 脚本加载增加 4s 超时（CDN 被墙时不再挂死）。
- **空输入密封产物非法**：`DataProvider` 构造时未设置 magic number，空输入（0 item）密封出的
  文件永远无法校验/解封。现在构造时即设置。
- **死导出清理**：移除始终为 `undefined` 的 `checkSealedData`/`unsealData` 导出。
- **新增导出**：`HeaderSize`、`BlockInfoSize`、`MaxItemSize`、`validateHeader`、`UnsealerCore`、
  `createInactivityWatchdog`；浏览器入口另导出 `inspectSealed`、`blobDownloadAndDecrypt`、
  `getBestWritable`、progress transformers。
- locale JSON 转为 JS 模块（裸 Node ESM 可直接 import，修复 `gen:fixtures` 崩溃）。

⚠️ 行为变更：以往"静默截断也算成功"的输入（密钥错误、数据不完整）现在会报错
（`ERR_DECRYPT_FAILED` / `ERR_TRUNCATED_INPUT`）——这是预期行为，损坏数据不应被当作成功。

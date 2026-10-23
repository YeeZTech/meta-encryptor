---
'@yeez-tech/meta-encryptor': minor
---

新增断点续传加密，接口与解密对称：`RecoverableSourceStream → Sealer({ context }) → RecoverableWriteStream`，
共用 `PipelineContextInFile`（同样支持优雅暂停与强退）。

- `Sealer` 输入固定按 64 KiB 切分成 item（此前按上游分片累积到 ≥64 KiB 为一个 item），
  `data_hash` 只取决于明文内容，续传结果与一次性加密一致；解密端无需任何改动。
- `Sealer` 新增选项 `context`、`progressHandler`（与 `Unsealer` 同签名）、`skipCommittedInput`
  （输入从源头开始时由 Sealer 跳过已封装部分，用于转码等无法按字节定位的输入），以及只读属性 `dataHash`。
- `PipelineContextInFile.loadContext({ sourcePath, outputPath })`：记录源文件大小与修改时间，
  不一致或输出文件短于断点时丢弃断点从头加密；源文件与输出相同时抛 `ERR_SEAL_INPLACE_UNSUPPORTED`。
  解密续传仍不传参数，行为不变。
- 加密断点字段：`readStart`（已封装明文字节）、`writeStart`、`readItemCount`、`dataHash`、
  `blockStarts`、`source`、`completed`；每次续传使用新的 ECDH 会话密钥，不保存密钥材料。

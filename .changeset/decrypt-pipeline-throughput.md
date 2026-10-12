---
'@yeez-tech/meta-encryptor': minor
---

解密 / 加密流水线吞吐优化（针对多文件并发解密总吞吐远低于单文件的问题，第一阶段：仅库内改动）。

- `RecoverableWriteStream` 写完成与流水线解耦：chunk 交给底层 `fs.WriteStream` 即 ack，
  不再让 `Unsealer` 等待每次 pwrite 的线程池往返；账本提交 / checkpoint 仍在真实写回调里按序进行。
  在途明文以 `maxInflightBytes` 为界（默认双文件 4 MiB、inplace 256 KiB），用于吸收 OS 对增长中
  文件的写入节流停顿。写入 / 后台落盘错误统一通过 `destroy(err)` 抛出一次。
- 双文件（密文 ≠ 输出）场景 checkpoint 不再随身携带 pending item 的密文（`readStart = rawCommitted`、
  `data` 为空，resume 时直接从完好的密文文件重读），`.progress` 体积不随在途 item 数增长；
  inplace 场景行为不变（pending 密文仍随 checkpoint 持久化，写前存档 WAL 保留）。
- `PipelineContextOptions.minSaveIntervalMs`（默认 0）：与 `saveFrequency` 叠加的 checkpoint 时间下限，
  供 Windows 等 open/write/close/rename 代价较高的环境拉长落盘间隔。流结束与 WAL 不受限制。
- `Sealer` / `Unsealer` / `SealedFileStream` / `RecoverableReadStream` / `RecoverableWriteStream`
  默认 `highWaterMark` 统一为 64 KiB（对齐 item 大小，`limits.DefaultStreamHighWaterMark`），
  不再依赖 Node 版本相关的 16 KiB 默认值；可显式覆盖。
- 热路径去拷贝：AES-GCM 加解密不再经 hex 字符串往返；`UnsealerCore` / `_decryptMessageWithPrefix`
  使用 `subarray` 视图；`SealedFileStream` 读缓冲 `allocUnsafe`；`Sealer` 累积改为分片列表、
  达阈值只拼一次，并去掉 `memory-streams` 中转。密封输出格式与密文字节完全不变。

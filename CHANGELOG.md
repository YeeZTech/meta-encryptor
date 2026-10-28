# @yeez-tech/meta-encryptor

## 5.3.0

### Minor Changes

- ea7eb7c: 加密提速：同一个文件的所有 item 共用一个封装会话。每个文件只生成一次临时私钥、只做一次
  ECDH + CMAC 派生，之后每个 item 仅做 AES-GCM；IV 由每 item 随机改为
  「4 字节随机前缀 ‖ 8 字节大端序号（从 0 递增）」，同一密钥下 IV 不会重复。

  密文布局不变（encrypted ‖ iv ‖ pubkey ‖ tag），每个 item 仍携带临时公钥与 IV，解密端无需任何改动，
  新旧版本封装的文件可以互相解密。`YPCCrypto._encryptMessage`（转发密钥等单条消息）行为不变；
  新增 `YPCCrypto.createSessionEncryptor(pkey, prefix)`。

- c371d14: 断点续传解密的 context 只在写端 checkpoint 时更新：`RecoverableReadStream` 与 `Unsealer`
  运行中不再改动 `readStart` / `data`（此前读端每读一块都 `Buffer.concat` 进 `data`、Unsealer
  再用 remaining 覆盖，二者从未被落盘使用）。修复运行中手动 `saveContext()` 会存下
  「readStart 超前、writeStart 未动」的不自洽存档、续传后明文缺段的问题；顺带省掉一次整条密文流的拷贝。
  inplace 解密依赖的回放 data、pendingBlocks 原始密文与写前存档逻辑不变。

  checkpoint 新增 `dataHash`（已提交 item 的滚动哈希，32 字节），`Unsealer` 续传时据此接着算，
  新增只读属性 `Unsealer.dataHash`（Node 入口，与 header.data_hash 同口径）。`.progress` 格式自描述，
  新旧版本可互读：旧存档无 `dataHash` 时照常续传，哈希只覆盖续传部分。

- 2580bd3: 新增断点续传加密，接口与解密对称：`RecoverableSourceStream → Sealer({ context }) → RecoverableWriteStream`，
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

## 5.2.0

### Minor Changes

- 265998f: 解密 / 加密流水线吞吐优化（针对多文件并发解密总吞吐远低于单文件的问题，第一阶段：仅库内改动）。

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
  - 续传已完成任务不再报 `ERR_VERSION_MISMATCH`：写端收尾时先把 `completed: true` 持久化进
    context 再 truncate；带该标记再建管道时读端直接结束、写端补做 truncate 并 'finish'
    （inplace 完成后文件已是明文、尾部 header 不存在，老路径会把明文当密封文件打开）。
    `loadContext()` 仍丢弃运行期字段 `decryptCompleted`（中间存档里可能出现在在途写入提交前）。
    `_final` 现在会等所有在途写入提交后再收尾。
  - `SealedFileStream` header 校验失败（`ERR_VERSION_MISMATCH` / `ERR_INVALID_MAGIC`）的
    `detail` 增加 `filePath`、`fileSize`、`tailHex`（尾部 64 字节原文），日志可直接判断尾部
    是明文、HTML 还是半截文件；错误消息里的 `actual` 是丢精度的 Number，不要用它反推。
  - `calculateSealedHashAsync` 扫盘改为双缓冲预读：哈希当前 4 MiB 窗口时并行读下一窗口，
    跨窗口的 item 在缓冲头部空隙拼接。页缓存热时约 +7%，冷文件（SSD）单文件约 +70%。
  - 滚动哈希（密封 / 解封 / 校验共用）改为流式 `update(prev); update(item)`，不再把
    `prev ‖ item` 拷到一块缓冲里；注入 `hashProvider` 的调用方仍走原拷贝路径。摘要不变。
  - 热路径去拷贝：AES-GCM 加解密不再经 hex 字符串往返；`UnsealerCore` / `_decryptMessageWithPrefix`
    使用 `subarray` 视图；`SealedFileStream` 读缓冲 `allocUnsafe`；`Sealer` 累积改为分片列表、
    达阈值只拼一次，并去掉 `memory-streams` 中转。密封输出格式与密文字节完全不变。

- cd0c2ea: 新增 `getSecp256k1Implementation()`，并在首次加密 / 解密时打印 secp256k1 的实现选择日志（logger：`meta-encryptor/secp256k1`），与 keccak256 的日志对应。
  secp256k1 的原生 addon 加载失败时会静默退回纯 JS 的 elliptic，加解密吞吐降到原来的 1/3~1/4；此时返回 `'elliptic'`，并打一条带加载报错的 warn 日志，便于从客户端日志里确认。

### Patch Changes

- 7ddd375: 修复 `isSealedFile` / `sealedFileVersion` / `dataHashOfSealedFile` 读取文件头后不关闭文件句柄的问题。
  此前每次调用都会泄漏一个只读句柄：被删除的密封文件在进程退出前一直占用磁盘空间，Windows 上文件名也可能残留。

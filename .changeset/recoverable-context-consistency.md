---
'@yeez-tech/meta-encryptor': minor
---

断点续传解密的 context 只在写端 checkpoint 时更新：`RecoverableReadStream` 与 `Unsealer`
运行中不再改动 `readStart` / `data`（此前读端每读一块都 `Buffer.concat` 进 `data`、Unsealer
再用 remaining 覆盖，二者从未被落盘使用）。修复运行中手动 `saveContext()` 会存下
「readStart 超前、writeStart 未动」的不自洽存档、续传后明文缺段的问题；顺带省掉一次整条密文流的拷贝。
inplace 解密依赖的回放 data、pendingBlocks 原始密文与写前存档逻辑不变。

checkpoint 新增 `dataHash`（已提交 item 的滚动哈希，32 字节），`Unsealer` 续传时据此接着算，
新增只读属性 `Unsealer.dataHash`（Node 入口，与 header.data_hash 同口径）。`.progress` 格式自描述，
新旧版本可互读：旧存档无 `dataHash` 时照常续传，哈希只覆盖续传部分。

---
'@yeez-tech/meta-encryptor': minor
---

加密提速：同一个文件的所有 item 共用一个封装会话。每个文件只生成一次临时私钥、只做一次
ECDH + CMAC 派生，之后每个 item 仅做 AES-GCM；IV 由每 item 随机改为
「4 字节随机前缀 ‖ 8 字节大端序号（从 0 递增）」，同一密钥下 IV 不会重复。

密文布局不变（encrypted ‖ iv ‖ pubkey ‖ tag），每个 item 仍携带临时公钥与 IV，解密端无需任何改动，
新旧版本封装的文件可以互相解密。`YPCCrypto._encryptMessage`（转发密钥等单条消息）行为不变；
新增 `YPCCrypto.createSessionEncryptor(pkey, prefix)`。

---
'@yeez-tech/meta-encryptor': minor
---

新增 `getSecp256k1Implementation()`，并在首次加密 / 解密时打印 secp256k1 的实现选择日志（logger：`meta-encryptor/secp256k1`），与 keccak256 的日志对应。
secp256k1 的原生 addon 加载失败时会静默退回纯 JS 的 elliptic，加解密吞吐降到原来的 1/3~1/4；此时返回 `'elliptic'`，并打一条带加载报错的 warn 日志，便于从客户端日志里确认。

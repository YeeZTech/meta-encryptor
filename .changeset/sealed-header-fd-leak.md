---
'@yeez-tech/meta-encryptor': patch
---

修复 `isSealedFile` / `sealedFileVersion` / `dataHashOfSealedFile` 读取文件头后不关闭文件句柄的问题。
此前每次调用都会泄漏一个只读句柄：被删除的密封文件在进程退出前一直占用磁盘空间，Windows 上文件名也可能残留。

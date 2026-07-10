---
"@yeez-tech/meta-encryptor": patch
---

修复加密输入切片越界泄漏、sealed 数据完整性绕过和 Recoverable 截断/恢复问题；
严格校验 header、item 与 checkpoint，补齐空文件和文件工具支持。

浏览器下载不再加载远程 StreamSaver 脚本，Range 下载会校验实体一致性，取消、
密钥或完整性错误不再触发 Blob 二次下载；字节进度拆分为 `onByteProgress`。

同时补齐 Node/Browser 类型入口、跨平台构建、可复现依赖和发布包验证。

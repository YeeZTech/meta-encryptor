---
"@yeez-tech/meta-encryptor": patch
---

Decrypt finalize: prefer `ftruncate(fd)` while the write fd is still open (fallback path truncate with short retries). Richer fs error fields for Sentry. Inplace write-ahead checkpoint unchanged for dual-path DSFT layout.

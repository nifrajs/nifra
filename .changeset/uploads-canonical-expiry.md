---
"@nifrajs/uploads": patch
---

`verifyDownloadUrl` now accepts `vexp` only in the plain decimal form `signDownloadUrl` writes. An expiry with leading zeros used to verify too, giving one signed grant several distinct URLs (cache keys, log lines, dedupe keys).

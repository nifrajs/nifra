---
"@nifrajs/proxy": patch
---

The proxy strips the single-IP headers a caller can forge (`X-Real-IP`, `True-Client-IP`, `CF-Connecting-IP`, `X-Client-IP`, `X-Cluster-Client-IP`, `Fastly-Client-IP`, `Client-IP`) before forwarding, as it already did for `Forwarded` and `X-Forwarded-*`. An upstream that trusts one of them could be told any client address. A fixed static `headers` entry can still set one explicitly.

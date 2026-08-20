---
"@nifrajs/agent": patch
"@nifrajs/auth": patch
"@nifrajs/cache": patch
"@nifrajs/image": patch
"@nifrajs/proxy": patch
"@nifrajs/uploads": patch
"@nifrajs/web": patch
---

Harden runtime boundaries and defaults: clean up subprocess abort listeners, support short Cloudflare
KV sessions, bound and incrementally sweep the default memory cache, make image reads and cancellation
safe, emit content-derived image validators, require trusted forwarded hosts, avoid caching dynamic SSR
metadata, and reject invalid upload or image limits.

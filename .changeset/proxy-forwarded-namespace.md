---
"@nifrajs/proxy": patch
---

`createProxy` drops every inbound `X-Forwarded-*` header, not only `X-Forwarded-For`, `-Host` and `-Proto`, so a client can no longer pass `X-Forwarded-Port` or `X-Forwarded-Prefix` to the upstream. Emit one deliberately as a fixed `headers` entry.

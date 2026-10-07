---
"@nifrajs/proxy": patch
---

A `Set-Cookie` the upstream names in its `Connection` header is no longer relayed to the client. Other cookies still arrive as separate `Set-Cookie` headers.

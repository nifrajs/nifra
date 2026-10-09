---
"@nifrajs/runner": patch
---

`runRequest` results keep every `Set-Cookie` value: a new `setCookie` array lists them in order, and `headers["set-cookie"]` joins them as `Headers.get` does instead of keeping only the last one.

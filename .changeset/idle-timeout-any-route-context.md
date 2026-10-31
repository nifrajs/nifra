---
"@nifrajs/core": patch
---

`withIdleTimeout(c, seconds, work)` accepts the context of any route, including one that declares a `body`, `query` or `headers` schema.

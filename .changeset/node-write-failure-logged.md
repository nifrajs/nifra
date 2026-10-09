---
"@nifrajs/node": patch
---

On Node, a response the runtime refuses to write (a header value carrying CR/LF set through `status(...)` or `c.set.headers`) answered `500` with nothing logged. The error now goes through the app's own `logger`, as it does on Bun.

---
"@nifrajs/node": patch
---

Reading a request header by name (`c.header()`, cookies, body framing, response-hook request views) no longer builds Node's full `req.headers` object first. A request that reads a handful of headers costs less CPU; repeated header names still merge exactly as Node merges them.

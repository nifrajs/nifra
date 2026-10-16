---
"@nifrajs/node": patch
---

`serve()` does less work per request on Node. In nifra's Node benchmark on Node 26.12 it was 3-4% behind fastify and is now within 2% of it. It reads `Host` from `req.rawHeaders`, so a request whose app reads no header never builds Node's `req.headers` object. When `Host` repeats, the first one wins, as it does in `req.headers`. It also no longer adds `finish` and `close` listeners to every response. A parser error behind pipelined requests still closes the connection only after the responses already dispatched on it are written, in order. The adapter now waits on those responses only when that error happens.

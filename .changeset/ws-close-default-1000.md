---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/deno": patch
---

`ws.close()` with no code sends 1000 on every runtime, and the `close` callback hears 1000. Bun sent
1000 already; Node, Deno and Workers sent a close with no status, which the peer reads as 1005.

---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/deno": patch
---

A WebSocket route with `validateSend: true` now checks its outbound frames against `sendSchema` on Node and Deno too, as it already did on Bun: a frame the schema refuses is dropped before it reaches the client and reported to the route's `error()`. Before, `@nifrajs/node` and `@nifrajs/deno` sent every frame unchecked. The upgrade outcome a nifra app hands an adapter now carries a `sender` that adapters wiring their own sockets build `ws.send` with.

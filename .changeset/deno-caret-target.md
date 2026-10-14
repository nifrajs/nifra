---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

A raw `^` in a request path now routes as `%5E` on Deno too, as it already did on Bun, Node and workerd. Deno's URL parser keeps a `^` in a path as written, so `GET /vault/^` reached `/vault/:id` there and the static `/vault/%5E` everywhere else. The cross-runtime request-target matrix gains the case.

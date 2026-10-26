---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/deno": patch
---

`@nifrajs/node` and `@nifrajs/deno` read core's WebSocket upgrade outcome through one generated type view, which core checks its own types against, instead of two hand-written mirrors.

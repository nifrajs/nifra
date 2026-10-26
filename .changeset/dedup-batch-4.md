---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/deno": patch
"@nifrajs/cli": patch
---

`@nifrajs/node` and `@nifrajs/deno` read core's WebSocket upgrade outcome through one generated type view, which core checks its own types against, instead of two hand-written mirrors.

The CLI's MCP workers share one request reader, its project children one stdout guard, six `nifra check` security scans one file walker, and its route-text scans one string-aware scanner.

---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/deno": patch
"@nifrajs/cli": patch
"@nifrajs/web": patch
---

`@nifrajs/node` and `@nifrajs/deno` read core's WebSocket upgrade outcome through one generated type view, which core checks its own types against, instead of two hand-written mirrors.

The CLI's MCP workers share one request reader, its project children one stdout guard, six `nifra check` security scans one file walker, and its route-text scans one string-aware scanner.

The Bun and Vite builds of `@nifrajs/web` share their client-entry, manifest and server-build steps, and the Vite client leak guard and server zone guard share one plugin body.

Core's evidence, diff and saga code share their schema-part mapping and saga ownership steps, its SQL and Durable Object lease stores share their row mapping and held-lease update, and the JSON body lane's byte readers share one settle step.

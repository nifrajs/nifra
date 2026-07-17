---
"@nifrajs/core": major
---

Optional server systems are now opt-in `.use()` plugins installed from dedicated subpaths - never server options, side-effect imports, or process-global registries.

- Enable request idempotency with `.use(idempotency())` from `@nifrajs/core/idempotency-plugin` - pass `{ store }` for a durable app-wide default. The `idempotencyStore` server option is removed.
- Enable the per-request effect ledger with `.use(effectLedger({ sink }))` from `@nifrajs/core/effect-ledger`. The `effectLedger` server option is removed.
- Enable MCP declarations (`.tool()`, `.resource()`, `.prompt()`) with `.use(mcp())` from `@nifrajs/core/mcp`. The package root does not activate them implicitly.
- Enable typed SSE routes (`.sse()`) with `.use(streaming())` from `@nifrajs/core/sse`.
- Enable WebSocket routes (`.ws()`) with `.use(websocket())` from `@nifrajs/core/ws`. The old `import "@nifrajs/core/ws"` side-effect no longer installs the runtime.
- A route that declares one of these without its plugin installed fails loudly at registration, so a gate can never be silently dropped by a forgotten plugin.

Each plugin installs its runtime on that server instance only - two servers in one process never share opt-in state. Merging a configured sub-app with `.use(subApp)` carries its installed runtimes across.

A `server()` that uses none of these pulls none of their code into its bundle, so the minimal server footprint is smaller.

Migration:

```ts
// before
server({ idempotencyStore, effectLedger: { sink } })

// after
import { effectLedger } from "@nifrajs/core/effect-ledger"
import { idempotency } from "@nifrajs/core/idempotency-plugin"
import { mcp } from "@nifrajs/core/mcp"
import { streaming } from "@nifrajs/core/sse"

server()
  .use(idempotency({ store: idempotencyStore }))
  .use(effectLedger({ sink }))
  .use(mcp()) // if the app declares tools/resources/prompts
  .use(streaming()) // if the app declares .sse() routes

// WebSocket apps:
// before: import "@nifrajs/core/ws"; server().ws(...)
// after:  import { websocket } from "@nifrajs/core/ws"; server().use(websocket()).ws(...)
```

Standalone callers of `app.resolveNode()` opt in with `.use(nodeDirect())` from `@nifrajs/core/node-direct`. The `@nifrajs/node` adapter installs it on `serve(app)` automatically, so normal Node deployments need no change and keep the direct JSON fast path.

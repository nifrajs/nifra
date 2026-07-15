# @nifrajs/deno

Run a [nifra](../../README.md) app on [Deno](https://deno.com) via `Deno.serve`.

```sh
deno add npm:@nifrajs/deno   # or import npm:@nifrajs/deno directly
```

```ts
import { server } from "@nifrajs/core/server"
import { serve } from "@nifrajs/deno"

const app = server().get("/users/:id", (c) => ({ id: c.params.id }))

const running = await serve(app, { port: 3000 })
// running.port           → the bound port (resolved; useful with `port: 0`)
// await running.stop()   → drain in-flight (Deno's shutdown()), then force-close
```

Because `Deno.serve`'s handler already speaks Web `Request`/`Response`, the app's `fetch`
*is* the handler — there's no stream bridge (unlike `@nifrajs/node`). This adapter just adds
a Bun-`listen()`-style graceful `stop()` and opt-in signals.

## Graceful shutdown on signals

```ts
await serve(app, { port: 3000, signals: true }) // SIGTERM/SIGINT → graceful stop()
```

## What you get for free

The request timeout (`server({ requestTimeoutMs })` → `503 request_timeout`) and body-size
cap live inside `app.fetch`, so they apply through this adapter automatically.

Works with any `{ fetch(req): Promise<Response> }` handler, not just nifra. ESM/TS. MIT.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.

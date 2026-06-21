# @nifrajs/node

Run a [nifra](../../README.md) app on Node's `http` server — nifra's ergonomics, deployed
on Node instead of Bun.

```sh
bun add @nifrajs/node   # or: npm add @nifrajs/node
```

```ts
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

const app = server().get("/users/:id", (c) => ({ id: c.params.id }))

const node = await serve(app, { port: 3000 })
// node.port            → the bound port (resolved; useful with `port: 0`)
// await node.stop()    → drain in-flight, then force-close (graceful shutdown)
```

`serve(app, { port })` bridges Node's stream-based `(req, res)` to/from the Web
`Request`/`Response` that `app.fetch` speaks — that's the only Bun-specific seam, since
nifra's lifecycle is already Web-standard. It also gives you a graceful `stop()`, the
Node equivalent of Bun's `app.listen()`.

## Public URL protocol

The adapter creates a plain Node `http` server, so `Request.url` uses `http://` by
default. If TLS terminates in front of Node, set the public protocol explicitly:

```ts
await serve(app, { port: 3000, protocol: "https" })
```

Forwarded protocol headers are not trusted automatically; pass a function only when your
own trusted infrastructure has validated the request:

```ts
await serve(app, {
  port: 3000,
  protocol: (req) => req.headers["x-forwarded-proto"] === "https" ? "https" : "http",
})
```

## Graceful shutdown on signals

Opt in to SIGTERM/SIGINT handling so a `docker stop` / Ctrl-C drains in-flight requests
before exit (mirrors Bun's `listen({ gracefulSignals })` — off by default, since owning
process signals should be a deliberate choice):

```ts
await serve(app, { port: 3000, signals: true })
```

## What you get for free

The request timeout (`server({ requestTimeoutMs })` → `503 request_timeout`) and body-size
cap live **inside `app.fetch`**, not Bun's `listen()` — so they apply through this adapter
with no extra wiring. Slow-client / slow-loris protection is Node's built-in
`requestTimeout` (300s) and `headersTimeout` (60s) defaults.

Works with any `{ fetch(req): Promise<Response> }` handler, not just nifra. ESM-only. MIT.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.

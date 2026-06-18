---
title: Runtimes & deployment
description: nifra is Bun-native, but app.fetch is a Web-standard handler — so the same app also runs on Deno, Cloudflare Workers, and the edge.
---

nifra is **Bun-native**: `app.listen()` uses `Bun.serve`, and graceful shutdown, connection
drain, and opt-in signal handling ride on it. That's the headline path. (The request
timeout and body cap live one layer deeper — inside `app.fetch` — so they're portable to
every runtime below, for free.)

But the entire request lifecycle is `app.fetch(Request): Promise<Response>` — a pure
Web-standard handler with **zero Bun APIs**. So the same `app` runs anywhere that
speaks `fetch`; you just hand `app.fetch` to that runtime's server instead of calling
`listen()`. (`@nifrajs/client`, `@nifrajs/schema`, and `@nifrajs/middleware` use no Bun APIs either —
`t` validates on every runtime, including the edge; see [Workers](#cloudflare-workers--module-workers).)

## Bun — the default

```ts
app.listen(3000) // + graceful stop, request timeout, body cap, opt-in signal handling
```

## Cloudflare Workers / module workers

```ts
export default app // `app` is a `{ fetch }` module worker (Bun auto-serves this shape too)
```

**Validation on the edge.** `@nifrajs/schema`'s `t` compiles its validator with `new Function` for speed
on Bun/Node — but the Workers runtime, and any environment whose CSP omits `unsafe-eval`, blocks
dynamic code generation. `t` detects that and falls back to TypeBox's eval-free `Value` checker, so the
**same `t`-validated routes run on Workers and other edge runtimes** with no code change (and no
performance cost on Bun/Node, where the compiled path is unchanged). nifra is schema-agnostic too, so
any [Standard Schema](https://standardschema.dev) library — [zod](https://zod.dev),
[valibot](https://valibot.dev) — also works; only `t` additionally emits JSON Schema + OpenAPI.

## Deno

`app.fetch` is exactly the handler `Deno.serve` wants, so the zero-dependency form works
today:

```ts
Deno.serve((req) => app.fetch(req))
```

For a graceful `stop()` (drains in-flight) plus opt-in signal handling, use
[`@nifrajs/deno`](../../../packages/deno):

```ts
import { serve } from "@nifrajs/deno"
const running = await serve(app, { port: 3000, signals: true })
// running.port → bound port · await running.stop() → graceful drain
```

## Node

Node has no fetch-style server, so use [`@nifrajs/node`](../../../packages/node) — it
bridges Node's `(req, res)` to/from `Request`/`Response` and adds a graceful `stop()`:

```ts
import { serve } from "@nifrajs/node"
const node = await serve(app, { port: 3000 }) // node.port, await node.stop()
```

When TLS terminates before Node, set the public URL protocol explicitly so `request.url`
matches the browser-facing scheme:

```ts
await serve(app, { port: 3000, protocol: "https" })
```

## What's portable, what isn't

| | Portable (Web standard) | Per-runtime adapter |
|---|---|---|
| Request lifecycle — `app.fetch` (routing, validation, middleware, contracts) | ✅ | — |
| `@nifrajs/client` / `@nifrajs/middleware` | ✅ | — |
| `@nifrajs/schema` (`t`) | ✅ all runtimes (compiled on Bun/Node, eval-free on edge) | — |
| Request timeout (503) · body-size cap | ✅ (inside `app.fetch`) | — |
| Serving | — | Bun `listen()` · `Deno.serve` / `@nifrajs/deno` · `@nifrajs/node` · Workers |
| Graceful shutdown · drain · signals | — | Bun `listen()` · `@nifrajs/deno` · `@nifrajs/node` |

The framework *core* — plus the request timeout and body cap — is runtime-agnostic; only
the **serve binding** and the shutdown/signal hardening differ per runtime, and
[`@nifrajs/node`](../../../packages/node) / [`@nifrajs/deno`](../../../packages/deno) bring those
to full parity with Bun's `listen()`. Bun stays first-class; every other runtime is one
`fetch` hand-off away. See [`examples/edge.ts`](https://github.com/nifra) for a runnable demo.

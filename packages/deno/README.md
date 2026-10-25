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
*is* the handler - there's no stream bridge (unlike `@nifrajs/node`). This adapter just adds
a Bun-`listen()`-style graceful `stop()` and opt-in signals.

## Graceful shutdown on signals

```ts
await serve(app, { port: 3000, signals: true }) // SIGTERM/SIGINT → graceful stop()
await serve(app, { port: 3000, signals: { drainMs: 8_000 } }) // the same, with an 8 s drain window
```

## Files ahead of the app

```ts
await serve(app, {
  port: 3000,
  static: (req) =>
    new URL(req.url).pathname === "/robots.txt" ? new Response("User-agent: *\n") : undefined,
})
```

`static` sees every request before the app does, so a file it answers wins over any route at the
same path. It returns a response, or `undefined` (or a promise of one) to let the app route the
request. No hook of the app runs for a request it answers, and a throw answers a plain `500`. The
server `nifra build --target deno` emits serves its client bundle and public files this way.

## Client disconnect and `c.req.signal`

`Deno.serve` aborts a request's `signal` when the client goes away and, by default, also once a
response has been sent in full. Deno prints a one-time notice about that default when it finishes
the response to a request whose `signal` was read. nifra reads it when it rebuilds a request (a
mounted app, a path with `.` or `..` segments, an idempotent route), so `c.req.signal` and
`fetch(c.req)` still follow a client that hangs up. To have the signal abort only on a disconnect,
and no notice, run Deno with `--unstable-no-legacy-abort`:

```sh
deno run --allow-net --unstable-no-legacy-abort main.ts
```

## What you get for free

The request timeout (`server({ requestTimeoutMs })` → `503 request_timeout`) and body-size
cap live inside `app.fetch`, so they apply through this adapter automatically.

Works with any `{ fetch(req): Promise<Response> }` handler, not just nifra. ESM/TS. MIT.

## WebSocket message size

`app.ws()` routes upgrade through `Deno.upgradeWebSocket`, which takes no size limit: Deno receives
each inbound message whole (up to its own limit, 64 MiB on Deno 2.9) before the app sees it.
`server({ wsMaxPayloadBytes })` then closes the socket with `1009` and keeps the message from your
handler, but it cannot bound the memory Deno spent receiving it. Where that matters, cap message
size in a proxy in front of the app. On Bun and Node the cap is enforced while the message arrives.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.

---
title: WebSockets
description: app.ws() registers a typed WebSocket route with an upgrade guard, a portable socket, and topic pub/sub — served on Bun, Deno, Node, and Cloudflare Workers.
---

`app.ws(path, handler)` registers a WebSocket route. It mirrors `.get()`/`.post()` — chainable, with
per-connection state typed through a generic — and runs on every runtime nifra serves: **Bun**,
**Deno**, **Node**, and **Cloudflare Workers**.

The WebSocket runtime ships as a subpath so apps that never use it don't bundle it (~1.5 KB gzipped
saved on the minimal-app size benchmark). Import it once at your server entry; `app.ws()` without it
fails loud at boot with `WS_RUNTIME_MISSING` pointing here. (`@nifrajs/workers`' `createWebSocketHub`
imports it for you.)

```ts
import { server } from "@nifrajs/core"
import "@nifrajs/core/ws" // registers the WebSocket runtime app.ws() needs

const app = server()
  .get("/", () => ({ ok: true }))
  .ws("/echo", {
    open: (ws) => ws.send("welcome"),
    message: (ws, data) => ws.send(data), // data: string | Uint8Array
  })

app.listen(3000) // Bun
```

## The lifecycle

```ts
app.ws<{ user: string }>("/chat", {
  // 1. upgrade(c) runs in the full HTTP request context, BEFORE the connection opens — authenticate,
  //    check origin, rate-limit. Return the initial per-connection data (→ ws.data, typed), or a
  //    Response to REJECT the upgrade (the client never connects). A thrown error rejects with 500.
  upgrade(c) {
    const user = c.cookies.session
    if (user === undefined) return new Response("unauthorized", { status: 401 })
    return { user }
  },
  open(ws) {
    ws.send(`welcome ${ws.data.user}`) // ws.data is { user: string }
  },
  message(ws, data) {
    ws.send(data) // text frames arrive as string, binary as Uint8Array (normalized across runtimes)
  },
  close(ws, code, reason) {},
  error(ws, err) {}, // a throw in any callback routes here, never crashing the connection
})
```

Every callback is optional — `{ message }` alone is a valid echo server. `upgrade` is the only one
that runs before the socket opens, so it's the one place to reject.

### `NifraWebSocket`

The `ws` handed to `open`/`message`/`close`/`error` is a portable wrapper over the runtime's native
socket:

| Member | |
|---|---|
| `send(data)` | text (`string`) or binary (`ArrayBuffer`/typed-array) |
| `close(code?, reason?)` | close the connection |
| `readonly readyState` | `0` CONNECTING · `1` OPEN · `2` CLOSING · `3` CLOSED |
| `subscribe(topic)` / `unsubscribe(topic)` | pub/sub (see below) |
| `data` | per-connection state, seeded by `upgrade()`, mutable |
| `readonly raw` | escape hatch to the native socket (Bun `ServerWebSocket`, Web `WebSocket`, `ws`) |

## Contract-validated messages

Inbound frames arrive raw (`string | Uint8Array`) by default. Add a **`messageSchema`** — any
[Standard Schema](https://standardschema.dev) (`t`, zod, valibot, …) — and nifra parses each frame as
JSON, validates it, and hands `message` the **typed** value; anything that fails parse or validation
goes to `onInvalidMessage` instead (so a malformed frame can never reach your handler):

```ts
import { t } from "@nifrajs/schema"

app.ws("/chat", {
  messageSchema: t.Object({ kind: t.Literal("say"), text: t.String({ maxLength: 500 }) }),
  message(ws, msg) {
    // msg is typed { kind: "say"; text: string } — already validated.
    app.publish("room", msg.text)
  },
  onInvalidMessage(ws, issues) {
    ws.send(JSON.stringify({ error: "bad message", issues }))
  },
})
```

Validation is wired once at registration, so it works identically on Bun, Deno, Node, and Workers.
Binary frames are decoded as UTF-8 before JSON parsing. Omit `onInvalidMessage` to silently drop
invalid frames.

## Pub/sub — `app.publish`

`ws.subscribe(topic)` joins a topic; `app.publish(topic, data)` broadcasts to everyone in it. A chat
room in five lines:

```ts
app.ws("/room/:id", {
  open: (ws) => ws.subscribe(`room`),
  message: (ws, text) => app.publish("room", text), // fan out to all subscribers
})
```

Subscriptions drop automatically when a connection closes. Bun, Deno, and Node are long-lived
processes, so this works directly (single-instance). Two notes on **where the sockets live**:

- **Cloudflare Workers** — use [`@nifrajs/workers`](../../../packages/workers). A stateless Worker can't
  broadcast across connections (each request is its own isolate), so nifra ships a **Durable Object
  hub**: `createWebSocketHub(app)` holds the connections and runs the registry, and
  `toFetchHandler(app, { webSocketHub })` routes upgrades to it — then `ws.subscribe` / `app.publish`
  behave exactly as on Bun. Two lines + a `wrangler.toml` binding:

  ```ts
  import { createWebSocketHub } from "@nifrajs/workers"

  export const NifraWebSocketHub = createWebSocketHub(app) // bind as NIFRA_WS_HUB in wrangler.toml
  export default toFetchHandler(app, { webSocketHub: (env) => env.NIFRA_WS_HUB })
  ```

  All connections route to one hub DO, so topics are app-global. See the
  [Workers chat example](https://github.com/nifra/nifra/tree/main/examples/websocket-workers).

- **Multi-instance (Bun/Deno/Node behind a load balancer).** `app.publish` only reaches sockets on the
  *same* instance. Bridge an external fan-out (Redis pub/sub, NATS, a message queue) to `app.publish` to
  broadcast across all of them.

## Serving — it's adapter-integrated, not `app.fetch`

nifra's HTTP lifecycle is `app.fetch(Request): Response`. A WebSocket upgrade **can't** go through
`app.fetch` — it needs the live socket, which only the runtime's serving layer holds. So WS is wired by
each serving entry; the upgrade primitive differs per runtime, but `app.ws()` and the handler are
identical everywhere:

| Runtime | Serve with | Upgrade primitive |
|---|---|---|
| **Bun** | `app.listen(port)` | `Bun.serve` `server.upgrade` + `websocket` config |
| **Deno** | `serve(app, …)` from [`@nifrajs/deno`](../../../packages/deno) | `Deno.upgradeWebSocket` |
| **Node** | `serve(app, …)` from [`@nifrajs/node`](../../../packages/node) | the `upgrade` event + the optional [`ws`](https://github.com/websockets/ws) package |
| **Cloudflare Workers** | `export default toFetchHandler(app)` | `WebSocketPair` + a `101` response |

**Node needs `ws`.** Node has no built-in WebSocket server, so `@nifrajs/node` uses `ws` — an **optional
peer dependency**, lazy-imported on the first upgrade (a non-WS Node app never loads it). Install it
when you use `app.ws()`:

```sh
npm i ws
```

If `ws` isn't installed, a WS upgrade gets a clean `501` (the HTTP routes are unaffected).

## Notes

- **Binary** frames are normalized to `Uint8Array` and text to `string`, the same on every runtime — no
  per-runtime `Buffer`/`ArrayBuffer`/`Blob` branching in your handler.
- **Validation.** Inbound messages arrive as raw `string | Uint8Array`. Validating them against a
  contract (`@nifrajs/schema`'s `t`, or any Standard Schema) is a normal next step — parse in `message`.
- **A WS path hit without an upgrade** (a plain `GET`) falls through to normal routing — define a `.get()`
  at the same path to serve, say, an HTML page next to the socket.

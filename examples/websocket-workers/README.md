# WebSocket chat on Cloudflare Workers

`app.publish` broadcasting across connections on Workers, via a **Durable Object hub** from
[`@nifrajs/workers`](../../packages/workers). A stateless Worker can't broadcast (each request is its own
isolate); the DO is the long-lived process that holds the sockets and runs nifra's pub/sub registry.

```sh
bunx wrangler dev   # open http://localhost:8787 in two tabs
```

## How it works

The `app.ws("/chat", …)` route is identical to the Bun/Deno/Node version — `ws.subscribe` + `app.publish`
unchanged. Two extra lines wire it to Workers:

```ts
export const NifraWebSocketHub = createWebSocketHub(app)              // the DO class
export default toFetchHandler(app, { webSocketHub: (env) => env.NIFRA_WS_HUB })  // route upgrades to it
```

plus the `wrangler.toml` binding:

```toml
[[durable_objects.bindings]]
name = "NIFRA_WS_HUB"
class_name = "NifraWebSocketHub"

[[migrations]]
tag = "v1"
new_classes = ["NifraWebSocketHub"]
```

All connections route to one hub DO, so topics are app-global (matching nifra's in-process pub/sub on
Bun/Deno/Node). For very high fan-out, shard by room by giving the hub a room-derived id.

## Deploy

```sh
bunx wrangler deploy
```

---
"@nifrajs/core": patch
"@nifrajs/workers": patch
---

With `toFetchHandler(app, { webSocketHub })` on Cloudflare Workers, a request that carries `Upgrade: websocket` for a path with no WebSocket route now gets that path's HTTP answer, as on Bun, Deno and Node. Before, the hub Durable Object answered every such request `426 Upgrade Required`, so a plain route returned 426 only on Workers with a hub. A non-GET request with an upgrade header (which cannot be a handshake) now stays on the normal fetch path instead of going to the hub. `createWebSocketHub` uses the app's `fetch` for this; a hub app without one still answers 426.

/**
 * A multiplayer chat on Cloudflare Workers — `app.publish` broadcasting across connections via a
 * Durable Object hub. Run it: `bunx wrangler dev` (then open http://localhost:8787 in two tabs).
 *
 * The only Workers-specific wiring is the two lines at the bottom + the wrangler.toml DO binding;
 * the `app.ws()` route is identical to the Bun/Deno/Node version.
 */
import { type DurableObjectNamespaceLike, server, toFetchHandler } from "@nifrajs/core"
import { createWebSocketHub } from "@nifrajs/workers"

interface Env {
  readonly NIFRA_WS_HUB: DurableObjectNamespaceLike
}

const app = server().get(
  "/",
  () => new Response(CLIENT_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
)

// `.ws()` is a separate statement (not chained into `const app = …`) so the handlers can reference
// `app.publish` without making `app`'s own initializer self-referential.
app.ws("/chat", {
  open: (ws) => ws.subscribe("room"),
  // Every connection lives in the hub DO, so this fans out to all of them.
  message: (_ws, text) => app.publish("room", typeof text === "string" ? text : "(binary)"),
  close: () => app.publish("room", "— someone left —"),
})

// 1. The Durable Object that holds the connections + runs the pub/sub. Bind it in wrangler.toml.
export const NifraWebSocketHub = createWebSocketHub(app)

// 2. Route WS upgrades to that hub; HTTP requests go to app.fetch as usual.
export default toFetchHandler<Env>(app, { webSocketHub: (env) => env.NIFRA_WS_HUB })

const CLIENT_HTML = `<!doctype html><meta charset="utf-8"><title>nifra chat</title>
<style>body{font:16px system-ui;max-width:40rem;margin:2rem auto}#log{border:1px solid #ccc;border-radius:8px;padding:1rem;height:60vh;overflow:auto}input{width:80%;padding:.5rem}button{padding:.5rem 1rem}</style>
<h1>nifra · Workers chat</h1><p>Open this page in two tabs and watch messages broadcast across connections.</p>
<div id="log"></div><form id="f"><input id="m" placeholder="say something…" autocomplete="off"><button>Send</button></form>
<script>
const log = document.getElementById("log")
const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/chat")
ws.onmessage = (e) => { const p = document.createElement("div"); p.textContent = e.data; log.append(p); log.scrollTop = log.scrollHeight }
document.getElementById("f").onsubmit = (e) => { e.preventDefault(); const m = document.getElementById("m"); if (m.value) { ws.send(m.value); m.value = "" } }
</script>`

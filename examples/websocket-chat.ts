/**
 * nifra WebSockets — a tiny chat server with an upgrade guard + topic pub/sub.
 *
 *   bun run examples/websocket-chat.ts     → open http://localhost:3000
 *
 * `app.ws()` + the handler are identical on every runtime; only the serve binding differs:
 *   Bun:               app.listen(3000)                          (this file)
 *   Deno:              serve(app, { port: 3000 })                from @nifrajs/deno
 *   Node:              serve(app, { port: 3000 })                from @nifrajs/node   (+ `npm i ws`)
 *   Cloudflare Workers: export default toFetchHandler(app)       (per-connection only; broadcast
 *                       across clients needs a Durable Object — see the WebSockets guide)
 */
import { server } from "@nifrajs/core"
import "@nifrajs/core/ws" // registers the WebSocket runtime app.ws() needs (kept out of no-WS bundles)

const PAGE = /* html */ `<!doctype html><meta charset=utf-8><title>nifra chat</title>
<style>body{font:14px system-ui;max-width:40rem;margin:2rem auto}#log{height:60vh;overflow:auto;border:1px solid #ccc;padding:.5rem}i{color:#888}</style>
<h3>nifra chat</h3><div id=log></div>
<form id=f><input id=m autocomplete=off placeholder="message…" style=width:80% autofocus> <button>send</button></form>
<script>
const name = prompt("your name") || "anon"
const ws = new WebSocket(\`ws://\${location.host}/chat?name=\${encodeURIComponent(name)}\`)
const log = document.getElementById("log")
const add = (html) => { log.insertAdjacentHTML("beforeend", html + "<br>"); log.scrollTop = log.scrollHeight }
ws.onmessage = (e) => { const m = JSON.parse(e.data); add(m.system ? \`<i>\${m.system}</i>\` : \`<b>\${m.from}:</b> \${m.text}\`) }
document.getElementById("f").onsubmit = (e) => { e.preventDefault(); const i = document.getElementById("m"); if (i.value) ws.send(i.value); i.value = "" }
</script>`

const app = server()
  .get("/", () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }))
  .ws<{ name: string }>("/chat", {
    upgrade(c) {
      const name = new URL(c.req.url).searchParams.get("name")?.slice(0, 32)
      if (name === undefined || name.length === 0)
        return new Response("name required", { status: 400 })
      return { name }
    },
    open(ws) {
      ws.subscribe("room")
      app.publish("room", JSON.stringify({ system: `${ws.data.name} joined` }))
    },
    message(ws, data) {
      const text = typeof data === "string" ? data.slice(0, 500) : "[binary]"
      app.publish("room", JSON.stringify({ from: ws.data.name, text }))
    },
    close(ws) {
      app.publish("room", JSON.stringify({ system: `${ws.data.name} left` }))
    },
  })

app.listen(3000)
console.log("nifra chat → http://localhost:3000")

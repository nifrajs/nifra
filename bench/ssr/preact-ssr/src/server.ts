import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { h } from "preact"
import render from "preact-render-to-string"
import { App } from "./app.tsx"
import { catalogItems } from "./catalog.ts"

const dir = fileURLToPath(new URL(".", import.meta.url))
const clientJs = readFileSync(`${dir}/client.js`, "utf8")

const port = Number(process.env.PORT ?? 4327)

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`)
  if (url.pathname === "/client.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
    res.end(clientJs)
    return
  }
  if (url.pathname !== "/") {
    res.writeHead(404)
    res.end("Not Found")
    return
  }
  const data = { items: catalogItems() }
  const body = render(h(App, { data }))
  const payload = JSON.stringify(data).replace(/</g, "\\u003c")
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Preact SSR bench</title></head><body><div id="root">${body}</div>` +
    `<script>window.__PREACT_BENCH_DATA__=${payload}</script>` +
    `<script type="module" src="/client.js"></script></body></html>`
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(html)
})

server.listen(port, "0.0.0.0", () => {
  console.log(`preact-ssr http://127.0.0.1:${port}`)
})

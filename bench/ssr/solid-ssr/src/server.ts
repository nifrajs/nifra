import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { renderToString } from "solid-js/web"
import { Page } from "./app.tsx"
import { catalogItems } from "./catalog.ts"

const dir = fileURLToPath(new URL(".", import.meta.url))
const clientJs = readFileSync(`${dir}/client.js`, "utf8")
const port = Number(process.env.PORT ?? 4328)

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
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
  const items = catalogItems()
  const body = renderToString(() => Page({ items }))
  const payload = JSON.stringify({ items }).replace(/</g, "\\u003c")
  const html = [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    '<title>Solid SSR bench</title></head><body><div id="root">',
    body,
    "</div><script>window.__SOLID_BENCH_DATA__=",
    payload,
    "</scr",
    'ipt><script type="module" src="/client.js"></scr',
    "ipt></body></html>",
  ].join("")
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(html)
})

server.listen(port, "0.0.0.0", () => {
  console.log(`solid-ssr http://127.0.0.1:${String(port)}`)
})

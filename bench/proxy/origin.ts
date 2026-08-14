/**
 * The shared upstream origin for the proxy benchmark - one process, spawned once, hit by every
 * proxy row in the matrix. Deliberately a bare `node:http` server with no framework: the number
 * under test is the PROXY's overhead, so the origin must be the same constant tax for everyone.
 *
 * It is intentionally not the fastest possible origin. A proxy row can never exceed its upstream,
 * so the origin caps every row equally and the honest signal is the RATIO between rows (and each
 * row's distance from the direct-to-origin baseline the runner measures first).
 *
 * Routes (kept tiny so payload serialization is not what is being timed):
 *   GET  /users/:id  → { id }
 *   POST /users      → echo { id, name }
 *
 *   node bench/proxy/origin.ts <port>
 */

import { createServer } from "node:http"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) throw new Error("usage: node bench/proxy/origin.ts <port>")

const USER_ID = /^\/users\/([^/?]+)/

createServer((req, res) => {
  const url = req.url ?? "/"
  if (req.method === "POST" && url.startsWith("/users")) {
    // Drain the body before answering: a proxy that streams a request upstream must see the
    // upstream actually consume it, or the row measures a half-open write instead of a round trip.
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      let name = "unknown"
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        if (typeof parsed === "object" && parsed !== null && "name" in parsed) {
          const candidate = (parsed as { name: unknown }).name
          if (typeof candidate === "string") name = candidate
        }
      } catch {
        // malformed body - answer the same shape anyway; the bench never sends one
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "1", name }))
    })
    return
  }
  const match = USER_ID.exec(url)
  if (match !== null) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: match[1] }))
    return
  }
  res.writeHead(200, { "content-type": "application/json" })
  res.end('{"hello":"world"}')
}).listen(port)

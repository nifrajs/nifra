// TEMPORARY: a bare Bun.serve doing the same work as server-nifra.ts, with no framework.
import { readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"

const path = process.env.GZIP_GAP_DATASET
if (path === undefined) throw new Error("GZIP_GAP_DATASET is not set")
const dataset: { price: number; quantity: number }[] = JSON.parse(readFileSync(path, "utf8"))
const port = Number(process.env.GZIP_GAP_PORT ?? 8080)
const encoder = new TextEncoder()

Bun.serve({
  port,
  reusePort: true,
  fetch(request) {
    const url = request.url
    const count = Math.min(
      Math.max(0, Number.parseInt(url.slice(url.lastIndexOf("/") + 1), 10) || 0),
      dataset.length,
    )
    const items = new Array<object>(count)
    for (let i = 0; i < count; i++) {
      const item = dataset[i]
      if (item === undefined) break
      items[i] = { ...item, total: item.price * item.quantity }
    }
    const text = JSON.stringify({ items, count })
    if ((request.headers.get("accept-encoding") ?? "").includes("gzip")) {
      return new Response(gzipSync(encoder.encode(text)), {
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      })
    }
    return new Response(text, { headers: { "content-type": "application/json" } })
  },
})

// TEMPORARY: the nifra side of the gzip comparison. Copied into each arm's checkout and run there,
// so `@nifrajs/*` resolve to that checkout's sources.
import { readFileSync } from "node:fs"
import { server } from "@nifrajs/core/server"
import { compression } from "@nifrajs/middleware"

const path = process.env.GZIP_GAP_DATASET
if (path === undefined) throw new Error("GZIP_GAP_DATASET is not set")
const dataset: { price: number; quantity: number }[] = JSON.parse(readFileSync(path, "utf8"))
const port = Number(process.env.GZIP_GAP_PORT ?? 8080)

function render(count: number): { items: object[]; count: number } {
  const items = new Array<object>(count)
  for (let i = 0; i < count; i++) {
    const item = dataset[i]
    if (item === undefined) break
    items[i] = { ...item, total: item.price * item.quantity }
  }
  return { items, count }
}

const clamp = (raw: string): number =>
  Math.min(Math.max(0, Number.parseInt(raw, 10) || 0), dataset.length)

// "json": the handler calls c.json; "value": it returns the object and the framework renders it.
const app =
  process.env.GZIP_GAP_STYLE === "value"
    ? server().group("/json", (g) =>
        g.use(compression()).get("/:count", (c) => render(clamp(c.params.count))),
      )
    : server().group("/json", (g) =>
        g.use(compression()).get("/:count", (c) => c.json(render(clamp(c.params.count)))),
      )
app.listen(port, { reusePort: true })

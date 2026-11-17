// TEMPORARY: the nifra side of the gzip comparison. Copied into each arm's checkout and run there,
// so `@nifrajs/*` resolve to that checkout's sources.
import { readFileSync } from "node:fs"
import { server } from "@nifrajs/core/server"
import { compression } from "@nifrajs/middleware"

const path = process.env.GZIP_GAP_DATASET
if (path === undefined) throw new Error("GZIP_GAP_DATASET is not set")
const dataset: { price: number; quantity: number }[] = JSON.parse(readFileSync(path, "utf8"))
const port = Number(process.env.GZIP_GAP_PORT ?? 8080)

server()
  .group("/json", (g) =>
    g.use(compression()).get("/:count", (c) => {
      const count = Math.min(Math.max(0, Number.parseInt(c.params.count, 10) || 0), dataset.length)
      const items = new Array<object>(count)
      for (let i = 0; i < count; i++) {
        const item = dataset[i]
        if (item === undefined) break
        items[i] = { ...item, total: item.price * item.quantity }
      }
      return c.json({ items, count })
    }),
  )
  .listen(port, { reusePort: true })

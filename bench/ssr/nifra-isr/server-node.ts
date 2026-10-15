import { readFileSync } from "node:fs"
import { server } from "@nifrajs/core/server"
import { serve } from "@nifrajs/node"
import { MemoryCacheStore, renderPageResult, withISR } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { App } from "../nifra/app.tsx"
import Layout from "../nifra/layout.tsx"
import { catalogItems } from "../shared/catalog.ts"

const clientJs = readFileSync(new URL("./client.js", import.meta.url), "utf8")
const app = server()
  .get(
    "/client.js",
    // nifra-expect NF-C007: the benchmark hydration asset intentionally returns JavaScript bytes
    () => new Response(clientJs, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
  )
  .get("/", () =>
    renderPageResult({
      adapter: reactAdapter,
      chain: [Layout, App],
      data: { items: catalogItems() },
      clientEntry: "/client.js",
      title: "nifra SSR bench (ISR, Node)",
    }),
  )
const store = new MemoryCacheStore({
  // nifra-expect NF-S006: the ISR benchmark intentionally measures the in-memory cache path
  allowInProduction: true,
})
const isr = withISR(app, {
  store,
  revalidate: 3600,
  now: () => Date.now(),
  key: (request) => {
    const url = new URL(request.url)
    return url.pathname === "/client.js" ? null : url.pathname + url.search
  },
})
await serve({ fetch: isr }, { port: Number(process.env.PORT ?? 4315), hostname: "127.0.0.1" })

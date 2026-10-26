/**
 * nifra + React ISR as docs/rendering teaches it: the built createWebApp wrapped in `withISR` from your
 * own server entry, since the generated server.js has no ISR. server-bun.ts and server-node.ts serve it.
 */
import { serveStatic } from "@nifrajs/core/serve-static"
import { createWebApp, MemoryCacheStore, withISR } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { clientEntry, manifest } from "../server-manifest"

const app = createWebApp({
  adapter: reactAdapter,
  manifest,
  clientEntry,
  title: "nifra SSR bench (React ISR)",
})
const store = new MemoryCacheStore({
  // nifra-expect NF-S006: the ISR benchmark intentionally measures the in-memory cache path
  allowInProduction: true,
})
const isr = withISR(app, { store, revalidate: 3600, now: () => Date.now() })
// The bundle sits in dist/, next to the client chunks in dist/assets/.
const assets = serveStatic({ dir: new URL("./assets/", import.meta.url) })

// Asset paths go to the file handler first, as in the generated server, so a page never costs a stat.
export function handle(req: Request): Promise<Response> {
  const served = assets(req)
  return served === undefined ? isr(req) : served.then((res) => res ?? isr(req))
}

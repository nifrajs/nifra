/**
 * nifra + React ISR as docs/rendering teaches it: the built createWebApp wrapped in `withISR` from your
 * own server entry, since the generated server.js has no ISR. server-bun.ts and server-node.ts serve it.
 */
import { fileURLToPath } from "node:url"
import { createWebApp, MemoryCacheStore, servePublicDir, withISR } from "@nifrajs/web"
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
const assets = servePublicDir({ dir: fileURLToPath(new URL("./", import.meta.url)) })
const notFound = (): Response => new Response("Not Found", { status: 404 })

// Asset paths go to the file handler first, as in the generated server, so a page never costs a stat.
export function handle(req: Request): Promise<Response> {
  return new URL(req.url).pathname.startsWith("/assets/")
    ? assets(req).then((res) => res ?? notFound())
    : isr(req)
}

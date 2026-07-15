/**
 * nifra + @nifrajs/web (React) SSR on NODE (via @nifrajs/node) — the same app as server.ts (Bun), so the
 * SSR bench can compare nifra to Next/Remix on the SAME runtime (Node), not just Bun-vs-Node. Bundled
 * for Node by build-node.ts; serves its own /client.js (read from disk next to the bundle).
 *
 *   node bench/ssr/nifra/dist-node/server-node.js
 */
import { readFileSync } from "node:fs"
import { server } from "@nifrajs/core/server"
import { serve } from "@nifrajs/node"
import { renderPageResult } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { type CatalogPageData, catalogItems } from "../shared/catalog.ts"
import { App } from "./app.tsx"
import Layout from "./layout.tsx"

const clientJs = readFileSync(new URL("./client.js", import.meta.url), "utf8")

function loader(): CatalogPageData {
  return { items: catalogItems() }
}

const app = server()
  .get(
    "/client.js",
    () => new Response(clientJs, { headers: { "content-type": "text/javascript" } }),
  )
  .get("/", () =>
    renderPageResult({
      adapter: reactAdapter,
      chain: [Layout, App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra SSR (React, Node)",
    }),
  )

await serve(app, { port: Number(process.env.PORT ?? 4200) })

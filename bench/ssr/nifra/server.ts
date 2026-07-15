/**
 * nifra + @nifrajs/web (React) SSR bench server, on nifra's home runtime (Bun, via `.listen()`).
 * Renders the identical 50-item list page per request and ships the hydration bundle.
 *
 *   bun run bench/ssr/nifra/build.ts      # build dist/client.js (the JS payload)
 *   PORT=4200 bun run bench/ssr/nifra/server.ts
 */
import { server } from "@nifrajs/core/server"
import { renderPage } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { type CatalogPageData, catalogItems } from "../shared/catalog.ts"
import { App } from "./app.tsx"
import Layout from "./layout.tsx"

const clientJs = await Bun.file(`${import.meta.dir}/dist/client.js`)
  .text()
  .catch(() => "// run build.ts first")

function loader(): CatalogPageData {
  return { items: catalogItems() }
}

const app = server()
  .get(
    "/client.js",
    () => new Response(clientJs, { headers: { "content-type": "text/javascript" } }),
  )
  .get("/", () =>
    renderPage({
      adapter: reactAdapter,
      chain: [Layout, App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra SSR (React)",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 4200))
console.log(`nifra-ssr http://localhost:${running.port}`)

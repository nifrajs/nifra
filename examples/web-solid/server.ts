/**
 * F2.1 example — a nifra app that server-renders a Solid layout CHAIN (Layout → Page) and
 * serves the client bundle that hydrates it. SSR is just a nifra route handler returning the
 * `renderPage` Response.
 *
 *   bun run examples/web-solid/build.ts                                    # build the client first
 *   bun --preload examples/web-solid/ssr-preload.ts examples/web-solid/server.ts
 */
import { server } from "@nifrajs/core/server"
import { renderPage } from "@nifrajs/web"
import { solidAdapter } from "@nifrajs/web-solid"
import { App, type PageData } from "./app.tsx"
import Layout from "./layout.tsx"

const clientJs = await Bun.file(`${import.meta.dir}/dist/client.js`)
  .text()
  .catch(() => "// run build.ts first")

// A plain typed loader. (The contract-first in-process `api` arrives in a later phase.)
function loader(): PageData {
  return {
    message: "nifra SSR + Solid — layout chain on the real @nifrajs/web packages",
    start: 41,
  }
}

const app = server()
  .get(
    "/client.js",
    () => new Response(clientJs, { headers: { "content-type": "text/javascript" } }),
  )
  .get("/", () =>
    renderPage({
      adapter: solidAdapter,
      chain: [Layout, App], // outermost layout → page
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra F2.1 (Solid)",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 3000))
console.log(`http://localhost:${running.port}`)

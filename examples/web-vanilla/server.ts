/**
 * nifra SSR with NO framework - the same `renderPage` seam as the React/Preact/Solid/Vue examples,
 * with the vanilla adapter. Loaders, layouts, head management and the router are unchanged; what
 * changes is that the browser receives zero framework bytes.
 *
 *   bun examples/web-vanilla/server.ts
 *
 * `hydrate: false` is not an optimisation here, it is the truth: there is no client runtime to
 * hydrate with. Where a page needs interactivity, add an island rather than a framework.
 */
import { server } from "@nifrajs/core/server"
import { renderPage } from "@nifrajs/web"
import { vanillaAdapter } from "@nifrajs/web-vanilla"
import { App, type PageData } from "./app.ts"
import { Layout } from "./layout.ts"

function loader(): PageData {
  return {
    message: "nifra SSR, no framework - same renderPage, 0 KB of client JS",
    hotels: [
      { name: "The Oberoi", pricePaise: 4_250_000 },
      { name: "Taj Lake Palace", pricePaise: 3_180_000 },
      { name: "Wildflower Hall", pricePaise: 2_900_000 },
    ],
  }
}

const app = server().get("/", () =>
  renderPage({
    adapter: vanillaAdapter,
    chain: [Layout, App],
    data: loader(),
    hydrate: false,
    title: "nifra + no framework",
  }),
)

const running = app.listen(Number(Bun.env.PORT ?? 3000))
console.log(`http://localhost:${running.port}`)

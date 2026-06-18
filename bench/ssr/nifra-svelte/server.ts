import { server } from "@nifrajs/core"
import { renderPage } from "@nifrajs/web"
import { svelteAdapter } from "@nifrajs/web-svelte"
import { type CatalogPageData, catalogItems } from "../shared/catalog.ts"
import App from "./App.svelte"

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
      adapter: svelteAdapter,
      chain: [App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra SSR bench (Svelte)",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 4322))
console.log(`nifra-svelte http://localhost:${running.port}`)

import { server } from "@nifrajs/core/server"
import { renderPage } from "@nifrajs/web"
import { vueAdapter } from "@nifrajs/web-vue"
import { type CatalogPageData, catalogItems } from "../shared/catalog.ts"
import { App } from "./app.ts"

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
      adapter: vueAdapter,
      chain: [App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra SSR bench (Vue)",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 4321))
console.log(`nifra-vue http://localhost:${running.port}`)

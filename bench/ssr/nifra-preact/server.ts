import { server } from "@nifrajs/core/server"
import { renderPage } from "@nifrajs/web"
import { preactAdapter } from "@nifrajs/web-preact"
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
      adapter: preactAdapter,
      chain: [App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra SSR bench (Preact)",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 4323))
console.log(`nifra-preact http://localhost:${running.port}`)

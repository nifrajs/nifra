import { server } from "@nifrajs/core/server"
import { renderPage } from "@nifrajs/web"
import { solidAdapter } from "@nifrajs/web-solid"
import { type CatalogPageData, catalogItems } from "../shared/catalog.ts"
import { App } from "./app.tsx"

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
      adapter: solidAdapter,
      chain: [App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra SSR bench (Solid)",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 4320))
console.log(`nifra-solid http://localhost:${running.port}`)

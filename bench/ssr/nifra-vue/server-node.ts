import { readFileSync } from "node:fs"
import { server } from "@nifrajs/core/server"
import { serve } from "@nifrajs/node"
import { renderPageResult } from "@nifrajs/web"
import { vueAdapter } from "@nifrajs/web-vue"
import { type CatalogPageData, catalogItems } from "../shared/catalog.ts"
import { App } from "./app.ts"

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
      adapter: vueAdapter,
      chain: [App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra SSR (Vue, Node)",
    }),
  )

await serve(app, { port: Number(process.env.PORT ?? 4351) })

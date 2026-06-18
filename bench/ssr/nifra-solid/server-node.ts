import { readFileSync } from "node:fs"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"
import { renderPageResult } from "@nifrajs/web"
import { solidAdapter } from "@nifrajs/web-solid"
import { type CatalogPageData, catalogItems } from "../shared/catalog.ts"
import { App } from "./app.tsx"

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
      adapter: solidAdapter,
      chain: [App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra SSR (Solid, Node)",
    }),
  )

await serve(app, { port: Number(process.env.PORT ?? 4350) })

import { renderPage } from "@nifrajs/web"
import { vueAdapter } from "@nifrajs/web-vue"
import { catalogItems } from "../shared/catalog.ts"
import App from "./App.vue"

/** The whole app, as code you would write yourself: one fetch handler that calls nifra's renderer. */
export function catalogHandler(clientJs: string): (req: Request) => Response | Promise<Response> {
  return (req) => {
    const { pathname } = new URL(req.url)
    if (pathname === "/") {
      return renderPage({
        adapter: vueAdapter,
        chain: [App],
        data: { items: catalogItems() },
        clientEntry: "/client.js",
        title: "nifra SSR bench (Vue)",
      })
    }
    if (pathname === "/client.js") {
      return new Response(clientJs, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      })
    }
    return new Response("Not Found", { status: 404 })
  }
}

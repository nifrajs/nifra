/**
 * nifra SSR + Vue — the SAME `renderPage` seam as the React/Solid examples, with the Vue adapter.
 * Proof the @nifrajs/web seam is framework-agnostic: only the adapter import + the components change.
 *
 *   bun run examples/web-vue/build.ts
 *   bun examples/web-vue/server.ts
 */
import { server } from "@nifrajs/core"
import { renderPage } from "@nifrajs/web"
import { vueAdapter } from "@nifrajs/web-vue"
import { App, type PageData } from "./app.ts"
import { Layout } from "./layout.ts"

const clientJs = await Bun.file(`${import.meta.dir}/dist/client.js`)
  .text()
  .catch(() => "// run build.ts first")

function loader(): PageData {
  return { message: "nifra SSR + Vue — same renderPage, different adapter", start: 41 }
}

const app = server()
  .get(
    "/client.js",
    () => new Response(clientJs, { headers: { "content-type": "text/javascript" } }),
  )
  .get("/", () =>
    renderPage({
      adapter: vueAdapter,
      chain: [Layout, App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra + Vue",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 3000))
console.log(`http://localhost:${running.port}`)

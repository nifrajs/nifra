/**
 * nifra SSR + Preact — the SAME `renderPage` seam as the React/Solid/Vue examples, with the Preact
 * adapter. Proof the @nifrajs/web seam is framework-agnostic: only the adapter import + the components
 * change.
 *
 *   bun run examples/web-preact/build.ts
 *   bun examples/web-preact/server.ts
 */
import { server } from "@nifrajs/core/server"
import { renderPage } from "@nifrajs/web"
import { preactAdapter } from "@nifrajs/web-preact"
import { App, type PageData } from "./app.ts"
import { Layout } from "./layout.ts"

const clientJs = await Bun.file(`${import.meta.dir}/dist/client.js`)
  .text()
  .catch(() => "// run build.ts first")

function loader(): PageData {
  return { message: "nifra SSR + Preact — same renderPage, different adapter", start: 41 }
}

const app = server()
  .get(
    "/client.js",
    () => new Response(clientJs, { headers: { "content-type": "text/javascript" } }),
  )
  .get("/", () =>
    renderPage({
      adapter: preactAdapter,
      chain: [Layout, App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra + Preact",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 3000))
console.log(`http://localhost:${running.port}`)

/**
 * F2.1 example — the SAME `renderPage` as the Solid example, with the React adapter, now
 * rendering a layout CHAIN (Layout → Page). Proof the @nifrajs/web seam is framework-agnostic:
 * only the adapter import + the components change.
 *
 *   bun run examples/web-react/build.ts
 *   bun examples/web-react/server.ts        # no SSR preload — React JSX is Bun-native
 */
import { server } from "@nifrajs/core/server"
import { renderPage } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { App, type PageData } from "./app.tsx"
import Layout from "./layout.tsx"

const clientJs = await Bun.file(`${import.meta.dir}/dist/client.js`)
  .text()
  .catch(() => "// run build.ts first")

function loader(): PageData {
  return { message: "nifra SSR + React — layout chain, same renderPage", start: 41 }
}

const app = server()
  .get(
    "/client.js",
    () => new Response(clientJs, { headers: { "content-type": "text/javascript" } }),
  )
  .get("/", () =>
    renderPage({
      adapter: reactAdapter,
      chain: [Layout, App], // outermost layout → page
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra F2.1 (React)",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 3000))
console.log(`http://localhost:${running.port}`)

/**
 * nifra SSR + Svelte — the SAME `renderPage` seam as the React/Solid/Vue/Preact examples, with the
 * Svelte adapter. Proof the @nifrajs/web seam is framework-agnostic: only the adapter import + the
 * components change. Run with the SSR plugin preloaded (it compiles the .svelte imports):
 *
 *   bun run examples/web-svelte/build.ts
 *   bun --preload examples/web-svelte/ssr-preload.ts examples/web-svelte/server.ts
 */
import { server } from "@nifrajs/core/server"
import { renderPage } from "@nifrajs/web"
import { svelteAdapter } from "@nifrajs/web-svelte"
import App from "./App.svelte"
import Layout from "./Layout.svelte"

const clientJs = await Bun.file(`${import.meta.dir}/dist/client.js`)
  .text()
  .catch(() => "// run build.ts first")

function loader(): { message: string; start: number } {
  return { message: "nifra SSR + Svelte — same renderPage, different adapter", start: 41 }
}

const app = server()
  .get(
    "/client.js",
    () => new Response(clientJs, { headers: { "content-type": "text/javascript" } }),
  )
  .get("/", () =>
    renderPage({
      adapter: svelteAdapter,
      chain: [Layout, App],
      data: loader(),
      clientEntry: "/client.js",
      title: "nifra + Svelte",
    }),
  )

const running = app.listen(Number(Bun.env.PORT ?? 3000))
console.log(`http://localhost:${running.port}`)

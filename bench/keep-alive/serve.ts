import { join } from "node:path"
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"
import { plugin } from "bun"

// Serves one bench app (`react` or `svelte`) and prints `{ url }` once listening. Svelte's SSR compiler
// plugin registers for the whole process, so each renderer runs in its own.
const renderer = process.argv[2]
if (renderer !== "react" && renderer !== "svelte") throw new Error("usage: serve.ts react|svelte")
if (renderer === "svelte") plugin(svelteBunPlugin("ssr"))
const { serveApp } = await import("../../packages/web/test/keep-alive-app.ts")
const app =
  renderer === "react"
    ? await serveApp({
        appDir: join(import.meta.dir, "react"),
        adapter: (await import("@nifrajs/web-react")).reactAdapter,
        clientModule: "@nifrajs/web-react/client",
      })
    : await serveApp({
        appDir: join(import.meta.dir, "svelte"),
        adapter: (await import("@nifrajs/web-svelte")).svelteAdapter,
        clientModule: "@nifrajs/web-svelte/client",
        plugins: [svelteBunPlugin("dom")],
      })
console.log(JSON.stringify({ url: app.url }))

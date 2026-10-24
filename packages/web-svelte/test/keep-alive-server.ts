import { join } from "node:path"
import { plugin } from "bun"
import { svelteBunPlugin } from "../src/plugin.ts"

// Serves the keep-alive fixture for keep-alive-browser.test.ts: Svelte's SSR compiler plugin registers
// for the whole process, so the server runs in its own. Prints `{ url }` once listening.
plugin(svelteBunPlugin("ssr"))
const { serveApp } = await import("../../web/test/keep-alive-app.ts")
const { svelteAdapter } = await import("../src/index.ts")
const app = await serveApp({
  appDir: join(import.meta.dir, "fixtures/keep-alive"),
  adapter: svelteAdapter,
  clientModule: "@nifrajs/web-svelte/client",
  plugins: [svelteBunPlugin("dom")],
  mode: process.argv[2] === "development" ? "development" : "production",
})
console.log(JSON.stringify({ url: app.url }))

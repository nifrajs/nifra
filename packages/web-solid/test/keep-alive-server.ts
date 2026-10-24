import { join } from "node:path"
import { plugin } from "bun"
import { solidBunPlugin } from "../src/plugin.ts"

// Serves the keep-alive fixture for keep-alive-browser.test.ts: Solid's SSR compiler plugin registers
// for the whole process, so the server runs in its own. Prints `{ url }` once listening.
plugin(solidBunPlugin("ssr"))
const { serveApp } = await import("../../web/test/keep-alive-app.ts")
const { solidAdapter } = await import("../src/index.ts")
const app = await serveApp({
  appDir: join(import.meta.dir, "fixtures/keep-alive"),
  adapter: solidAdapter,
  clientModule: "@nifrajs/web-solid/client",
  plugins: [solidBunPlugin("dom")],
  mode: process.argv[2] === "development" ? "development" : "production",
})
console.log(JSON.stringify({ url: app.url }))

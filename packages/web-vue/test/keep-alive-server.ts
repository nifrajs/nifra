import { join } from "node:path"
import { plugin } from "bun"
import { vueBunPlugin } from "../src/plugin.ts"

// Serves a keep-alive fixture (`keep-alive` unless the second argument names another) for
// keep-alive-browser.test.ts: Vue's SSR compiler plugin registers for the whole process, so the server
// runs in its own. Prints `{ url }` once listening.
plugin(vueBunPlugin("ssr"))
const { serveApp } = await import("../../web/test/keep-alive-app.ts")
const { vueAdapter } = await import("../src/index.ts")
const app = await serveApp({
  appDir: join(import.meta.dir, "fixtures", process.argv[3] ?? "keep-alive"),
  adapter: vueAdapter,
  clientModule: "@nifrajs/web-vue/client",
  plugins: [vueBunPlugin("dom")],
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
  mode: process.argv[2] === "development" ? "development" : "production",
})
console.log(JSON.stringify({ url: app.url }))

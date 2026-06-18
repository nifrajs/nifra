// Build for Deno → dist-deno/ (server-deno.js + client assets). `bun run build:deno`.
// Run: `deno task start` (or deployctl for Deno Deploy).
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { vueBunPlugin } from "@nifrajs/web-vue/plugin"

const dir = import.meta.dir
const dist = `${dir}/dist-deno`
const define = {
  "process.env.NODE_ENV": '"production"',
  __VUE_OPTIONS_API__: "true",
  __VUE_PROD_DEVTOOLS__: "false",
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
}
rmSync(dist, { recursive: true, force: true })
mkdirSync(`${dist}/assets`, { recursive: true })

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dist}/assets`,
  clientModule: "@nifrajs/web-vue/client",
  plugins: [vueBunPlugin("dom")], // compile .vue SFCs → client bundle
  conditions: ["bun", "browser"],
  define,
})
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/server-deno.ts`,
  outDir: `${dir}/.build-deno`,
  clientEntry: client.entry,
  plugins: [vueBunPlugin("ssr")], // compile .vue SFCs → SSR
  define,
})
cpSync(worker, `${dist}/server-deno.js`)
rmSync(`${dir}/.build-deno`, { recursive: true, force: true })
console.log("Deno output → dist-deno (run: deno run -A dist-deno/server-deno.js)")

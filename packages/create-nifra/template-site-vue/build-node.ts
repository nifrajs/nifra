// Build for Node → dist-node/ (server-node.js + client assets). `bun run build:node`.
// Run: `node dist-node/server-node.js` (or the Dockerfile).
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { vueBunPlugin } from "@nifrajs/web-vue/plugin"

const dir = import.meta.dir
const dist = `${dir}/dist-node`
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
  serverEntry: `${dir}/server-node.ts`,
  outDir: `${dir}/.build-node`,
  target: "node",
  clientEntry: client.entry,
  plugins: [vueBunPlugin("ssr")], // compile .vue SFCs → SSR
  define,
})
cpSync(worker, `${dist}/server-node.js`)
rmSync(`${dir}/.build-node`, { recursive: true, force: true })
console.log("Node output → dist-node (run: node dist-node/server-node.js)")

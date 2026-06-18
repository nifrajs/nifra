// Build for Node → dist-node/ (server-node.js + client assets). `bun run build:node`.
// Run: `node dist-node/server-node.js` (or the Dockerfile). `node`+`solid` → solid-js/web's server build.
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { solidBunPlugin } from "@nifrajs/web-solid"

const dir = import.meta.dir
const dist = `${dir}/dist-node`
const define = { "process.env.NODE_ENV": '"production"' }
rmSync(dist, { recursive: true, force: true })
mkdirSync(`${dist}/assets`, { recursive: true })

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dist}/assets`,
  clientModule: "@nifrajs/web-solid/client",
  plugins: [solidBunPlugin("dom")],
  conditions: ["bun", "solid", "browser"],
  define,
})
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/server-node.ts`,
  outDir: `${dir}/.build-node`,
  target: "node",
  clientEntry: client.entry,
  plugins: [solidBunPlugin("ssr")],
  conditions: ["node", "solid"],
  define,
})
cpSync(worker, `${dist}/server-node.js`)
rmSync(`${dir}/.build-node`, { recursive: true, force: true })
console.log("Node output → dist-node (run: node dist-node/server-node.js)")

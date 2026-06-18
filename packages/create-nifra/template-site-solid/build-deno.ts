// Build for Deno → dist-deno/ (server-deno.js + client assets). `bun run build:deno`.
// Run: `deno task start` (or deployctl). Deno runs the edge bundle (workerd/edge-light + solid).
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { solidBunPlugin } from "@nifrajs/web-solid"

const dir = import.meta.dir
const dist = `${dir}/dist-deno`
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
  serverEntry: `${dir}/server-deno.ts`,
  outDir: `${dir}/.build-deno`,
  clientEntry: client.entry,
  plugins: [solidBunPlugin("ssr")],
  conditions: ["workerd", "edge-light", "solid", "browser"],
  define,
})
cpSync(worker, `${dist}/server-deno.js`)
rmSync(`${dir}/.build-deno`, { recursive: true, force: true })
console.log("Deno output → dist-deno (run: deno run -A dist-deno/server-deno.js)")

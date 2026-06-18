// Build for Bun (nifra's flagship runtime) → dist-bun/ (server-bun.js + client assets).
// `bun run build:bun`. Run: `bun dist-bun/server-bun.js`.
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { solidBunPlugin } from "@nifrajs/web-solid"

const dir = import.meta.dir
const dist = `${dir}/dist-bun`
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
  serverEntry: `${dir}/server-bun.ts`,
  outDir: `${dir}/.build-bun`,
  target: "bun",
  clientEntry: client.entry,
  plugins: [solidBunPlugin("ssr")],
  conditions: ["bun", "solid"],
  define,
})
cpSync(worker, `${dist}/server-bun.js`)
rmSync(`${dir}/.build-bun`, { recursive: true, force: true })
console.log("Bun output → dist-bun (run: bun dist-bun/server-bun.js)")

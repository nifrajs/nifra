// Build for Cloudflare Pages → dist/ (_worker.js + _routes.json + client assets). `bun run build`.
// Solid: solidBunPlugin("dom") for the client, ("ssr") for the server + the `solid` export condition.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { solidBunPlugin } from "@nifrajs/web-solid"

const dir = import.meta.dir
const dist = `${dir}/dist`
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
  serverEntry: `${dir}/_worker.ts`,
  outDir: `${dir}/.build`,
  clientEntry: client.entry,
  plugins: [solidBunPlugin("ssr")],
  conditions: ["workerd", "edge-light", "solid", "browser"],
  define,
})
cpSync(worker, `${dist}/_worker.js`)
rmSync(`${dir}/.build`, { recursive: true, force: true })
writeFileSync(
  `${dist}/_routes.json`,
  `${JSON.stringify({ version: 1, include: ["/*"], exclude: ["/assets/*"] }, null, 2)}\n`,
)
console.log("Cloudflare Pages output → dist (deploy: wrangler pages deploy dist)")

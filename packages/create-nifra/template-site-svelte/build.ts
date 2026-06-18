// Build for Cloudflare Pages → dist/ (_worker.js + _routes.json + client assets). `bun run build`.
// Svelte: svelteBunPlugin("dom") compiles .svelte for the client, ("ssr") for the server bundle.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"

const dir = import.meta.dir
const dist = `${dir}/dist`
const define = { "process.env.NODE_ENV": '"production"' }
rmSync(dist, { recursive: true, force: true })
mkdirSync(`${dist}/assets`, { recursive: true })

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dist}/assets`,
  clientModule: "@nifrajs/web-svelte/client",
  plugins: [svelteBunPlugin("dom")],
  conditions: ["bun", "browser"],
  define,
})
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/_worker.ts`,
  outDir: `${dir}/.build`,
  clientEntry: client.entry,
  plugins: [svelteBunPlugin("ssr")],
  define,
})
cpSync(worker, `${dist}/_worker.js`)
rmSync(`${dir}/.build`, { recursive: true, force: true })
writeFileSync(
  `${dist}/_routes.json`,
  `${JSON.stringify({ version: 1, include: ["/*"], exclude: ["/assets/*"] }, null, 2)}\n`,
)
console.log("Cloudflare Pages output → dist (deploy: wrangler pages deploy dist)")

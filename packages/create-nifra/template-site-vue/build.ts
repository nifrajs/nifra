// Build for Cloudflare Pages → dist/ (_worker.js + _routes.json + client assets). `bun run build`.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { vueBunPlugin } from "@nifrajs/web-vue/plugin"

const dir = import.meta.dir
const dist = `${dir}/dist`
// Vue feature flags: silence "feature flag not explicitly defined" warnings + trim dev-only code.
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
  serverEntry: `${dir}/_worker.ts`,
  outDir: `${dir}/.build`,
  clientEntry: client.entry,
  plugins: [vueBunPlugin("ssr")], // compile .vue SFCs → SSR
  define,
})
cpSync(worker, `${dist}/_worker.js`)
rmSync(`${dir}/.build`, { recursive: true, force: true })
writeFileSync(
  `${dist}/_routes.json`,
  `${JSON.stringify({ version: 1, include: ["/*"], exclude: ["/assets/*"] }, null, 2)}\n`,
)
console.log("Cloudflare Pages output → dist (deploy: wrangler pages deploy dist)")

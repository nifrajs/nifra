// Build for Vercel, emitting Vercel's Build Output API v3 at .vercel/output/ so it deploys with no
// framework preset: `vercel deploy --prebuilt`. Layout:
//   .vercel/output/config.json                   — serve static files, else SSR via the function
//   .vercel/output/static/assets/<client bundle>  — Vercel's CDN serves these directly
//   .vercel/output/functions/index.func/index.js  — the Edge SSR function (+ .vc-config.json)
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { vueBunPlugin } from "@nifrajs/web-vue/plugin"

const dir = import.meta.dir
const out = `${dir}/.vercel/output`
const fn = `${out}/functions/index.func`
const define = {
  "process.env.NODE_ENV": '"production"',
  __VUE_OPTIONS_API__: "true",
  __VUE_PROD_DEVTOOLS__: "false",
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
}
rmSync(`${dir}/.vercel`, { recursive: true, force: true })
mkdirSync(`${out}/static/assets`, { recursive: true })
mkdirSync(fn, { recursive: true })

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${out}/static/assets`,
  clientModule: "@nifrajs/web-vue/client",
  plugins: [vueBunPlugin("dom")], // compile .vue SFCs → client bundle
  conditions: ["bun", "browser"],
  define,
})
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/server-vercel.ts`,
  outDir: `${dir}/.build-vercel`,
  clientEntry: client.entry,
  plugins: [vueBunPlugin("ssr")], // compile .vue SFCs → SSR
  define,
})
cpSync(worker, `${fn}/index.js`)
rmSync(`${dir}/.build-vercel`, { recursive: true, force: true })

writeFileSync(
  `${fn}/.vc-config.json`,
  `${JSON.stringify({ runtime: "edge", entrypoint: "index.js" }, null, 2)}\n`,
)
writeFileSync(
  `${out}/config.json`,
  `${JSON.stringify(
    { version: 3, routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }] },
    null,
    2,
  )}\n`,
)
console.log("Vercel output → .vercel/output (deploy: vercel deploy --prebuilt)")

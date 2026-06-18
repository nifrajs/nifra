// Build for Vercel, emitting Vercel's Build Output API v3 at .vercel/output/ so it deploys with no
// framework preset: `vercel deploy --prebuilt`.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { solidBunPlugin } from "@nifrajs/web-solid"

const dir = import.meta.dir
const out = `${dir}/.vercel/output`
const fn = `${out}/functions/index.func`
const define = { "process.env.NODE_ENV": '"production"' }
rmSync(`${dir}/.vercel`, { recursive: true, force: true })
mkdirSync(`${out}/static/assets`, { recursive: true })
mkdirSync(fn, { recursive: true })

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${out}/static/assets`,
  clientModule: "@nifrajs/web-solid/client",
  plugins: [solidBunPlugin("dom")],
  conditions: ["bun", "solid", "browser"],
  define,
})
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/server-vercel.ts`,
  outDir: `${dir}/.build-vercel`,
  clientEntry: client.entry,
  plugins: [solidBunPlugin("ssr")],
  conditions: ["workerd", "edge-light", "solid", "browser"],
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

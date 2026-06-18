// Build for Vercel, emitting Vercel's Build Output API v3 at .vercel/output/ so it deploys with no
// framework preset: `vercel deploy --prebuilt`. Layout:
//   .vercel/output/config.json                   — serve static files, else SSR via the function
//   .vercel/output/static/assets/<client bundle>  — Vercel's CDN serves these directly
//   .vercel/output/functions/index.func/index.js  — the Edge SSR function (+ .vc-config.json)
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"

const dir = import.meta.dir
const out = `${dir}/.vercel/output`
const fn = `${out}/functions/index.func`
rmSync(`${dir}/.vercel`, { recursive: true, force: true })
mkdirSync(`${out}/static/assets`, { recursive: true })
mkdirSync(fn, { recursive: true })

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${out}/static/assets`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/server-vercel.ts`,
  outDir: `${dir}/.build-vercel`,
  clientEntry: client.entry,
})
cpSync(worker, `${fn}/index.js`)
rmSync(`${dir}/.build-vercel`, { recursive: true, force: true })

// Build Output API v3: serve real files first (`handle: filesystem` → /assets/*), then SSR the rest.
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

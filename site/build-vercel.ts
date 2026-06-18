/**
 * Build the site for Vercel, emitting Vercel's **Build Output API v3** at site/.vercel/output/ so it
 * deploys with no framework preset: `vercel deploy --prebuilt` (or `vercel deploy` after `vercel build`).
 * Layout:
 *   .vercel/output/config.json                      — serve static files, else SSR via the function
 *   .vercel/output/static/assets/<client bundle>     — Vercel's CDN serves these directly
 *   .vercel/output/functions/index.func/index.js     — the Edge SSR function (default fetch handler)
 *   .vercel/output/functions/index.func/.vc-config.json
 *
 *   bun run site/build-vercel.ts
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { buildSiteIslands } from "./build-islands"

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
await buildSiteIslands({ outDir: `${out}/static/assets` })

// Default target ("browser") = edge conditions (workerd/edge-light) — the Vercel Edge runtime.
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/server-vercel.ts`,
  outDir: `${dir}/.build-vercel`,
  clientEntry: client.entry,
})

cpSync(worker, `${fn}/index.js`)
cpSync(`${dir}/public/favicon.png`, `${out}/static/assets/favicon.png`)
cpSync(`${dir}/public/apple-touch-icon.png`, `${out}/static/assets/apple-touch-icon.png`)
cpSync(`${dir}/public/logo-mark.png`, `${out}/static/assets/logo-mark.png`)
cpSync(`${dir}/public/og.jpg`, `${out}/static/assets/og.jpg`)
cpSync(`${dir}/public/background.png`, `${out}/static/assets/background.png`)
cpSync(`${dir}/public/nifra-bot-avatar.png`, `${out}/static/assets/nifra-bot-avatar.png`)
rmSync(`${dir}/.build-vercel`, { recursive: true, force: true })

// Build Output API v3: the function is an Edge runtime entry; routing serves real files first
// (`handle: filesystem` → /assets/*, /og.svg), then sends everything else to the SSR function.
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

console.log(
  `Vercel output → site/.vercel/output (deploy: vercel deploy --prebuilt, client ${client.entry})`,
)

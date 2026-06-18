/**
 * Build the site for Deno. Output: site/dist-deno/ — server-deno.js (edge build: workerd/edge-light
 * conditions, runs under Deno's Web-standard runtime) + the shared client bundle under assets/. Run
 * with `deno run --allow-net --allow-read --allow-env site/dist-deno/server-deno.js`.
 *
 *   bun run site/build-deno.ts
 */
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { buildSiteIslands } from "./build-islands"

const dir = import.meta.dir
const dist = `${dir}/dist-deno`

rmSync(dist, { recursive: true, force: true })
mkdirSync(`${dist}/assets`, { recursive: true })

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dist}/assets`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
await buildSiteIslands({ outDir: `${dist}/assets` })

// Default target ("browser") = edge conditions — a Web-standard bundle Deno runs natively.
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/server-deno.ts`,
  outDir: `${dir}/.build-deno`,
  clientEntry: client.entry,
})

cpSync(worker, `${dist}/server-deno.js`)
cpSync(`${dir}/public/favicon.png`, `${dist}/assets/favicon.png`)
cpSync(`${dir}/public/apple-touch-icon.png`, `${dist}/assets/apple-touch-icon.png`)
cpSync(`${dir}/public/logo-mark.png`, `${dist}/assets/logo-mark.png`)
cpSync(`${dir}/public/og.jpg`, `${dist}/assets/og.jpg`)
cpSync(`${dir}/public/background.png`, `${dist}/assets/background.png`)
cpSync(`${dir}/public/nifra-bot-avatar.png`, `${dist}/assets/nifra-bot-avatar.png`)
rmSync(`${dir}/.build-deno`, { recursive: true, force: true })

console.log(`Deno output: site/dist-deno (server-deno.js + client ${client.entry})`)

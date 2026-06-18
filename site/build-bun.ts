/**
 * Build the site for Bun (Nifra's flagship runtime). Output: site/dist-bun/ — server-bun.js + client
 * assets. Run: `bun dist-bun/server-bun.js`.
 *
 *   bun run site/build-bun.ts
 */
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { buildSiteIslands } from "./build-islands"

const dir = import.meta.dir
const dist = `${dir}/dist-bun`

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

const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/server-bun.ts`,
  outDir: `${dir}/.build-bun`,
  target: "bun",
  clientEntry: client.entry,
})

cpSync(worker, `${dist}/server-bun.js`)
cpSync(`${dir}/public/favicon.png`, `${dist}/assets/favicon.png`)
cpSync(`${dir}/public/apple-touch-icon.png`, `${dist}/assets/apple-touch-icon.png`)
cpSync(`${dir}/public/logo-mark.png`, `${dist}/assets/logo-mark.png`)
cpSync(`${dir}/public/og.jpg`, `${dist}/assets/og.jpg`)
cpSync(`${dir}/public/background.png`, `${dist}/assets/background.png`)
cpSync(`${dir}/public/nifra-bot-avatar.png`, `${dist}/assets/nifra-bot-avatar.png`)
rmSync(`${dir}/.build-bun`, { recursive: true, force: true })

console.log("Bun output → dist-bun (run: bun dist-bun/server-bun.js)")

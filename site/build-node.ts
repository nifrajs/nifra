/**
 * Build the site for Node. Output: site/dist-node/ — server-node.js (the @nifrajs/node server, target
 * `node` so node:* stay external) + the shared client bundle under assets/. Run with
 * `node site/dist-node/server-node.js`. Same source as the Cloudflare build; only the server differs.
 *
 *   bun run site/build-node.ts
 */
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { buildSiteIslands } from "./build-islands"

const dir = import.meta.dir
const dist = `${dir}/dist-node`

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
  serverEntry: `${dir}/server-node.ts`,
  outDir: `${dir}/.build-node`,
  target: "node", // node:* external; react-dom resolves to its Node SSR build
  clientEntry: client.entry,
})

cpSync(worker, `${dist}/server-node.js`)
cpSync(`${dir}/public/favicon.png`, `${dist}/assets/favicon.png`)
cpSync(`${dir}/public/apple-touch-icon.png`, `${dist}/assets/apple-touch-icon.png`)
cpSync(`${dir}/public/logo-mark.png`, `${dist}/assets/logo-mark.png`)
cpSync(`${dir}/public/og.jpg`, `${dist}/assets/og.jpg`)
cpSync(`${dir}/public/background.png`, `${dist}/assets/background.png`)
cpSync(`${dir}/public/nifra-bot-avatar.png`, `${dist}/assets/nifra-bot-avatar.png`)
rmSync(`${dir}/.build-node`, { recursive: true, force: true })

console.log(`Node output: site/dist-node (server-node.js + client ${client.entry})`)

/**
 * Build the nifra SSR bench app for Node → bench/ssr/nifra/dist-node/ (client.js + server-node.js,
 * target `node`). Run with `node bench/ssr/nifra/dist-node/server-node.js`. Same app as the Bun
 * build; only the server target differs.
 *
 *   bun run bench/ssr/nifra/build-node.ts
 */
import { mkdirSync, rmSync } from "node:fs"

const dir = import.meta.dir
const dist = `${dir}/dist-node`
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const define = { "process.env.NODE_ENV": '"production"' }
const nodeSourceConditions = ["bun", "node"]

// Client hydration bundle (browser) — served by the app at /client.js.
const client = await Bun.build({
  entrypoints: [`${dir}/client.ts`],
  outdir: dist,
  target: "browser",
  conditions: ["bun", "browser"],
  naming: "client.js",
  minify: true,
  define,
})
// Server bundle (target node → react-dom Node SSR build, node:* external).
const srv = await Bun.build({
  entrypoints: [`${dir}/server-node.ts`],
  outdir: dist,
  target: "node",
  conditions: nodeSourceConditions,
  minify: true,
  define,
})

for (const r of [client, srv]) {
  if (!r.success) {
    for (const log of r.logs) console.error(log)
    process.exit(1)
  }
}
console.log("Node bench build → bench/ssr/nifra/dist-node (client.js + server-node.js)")

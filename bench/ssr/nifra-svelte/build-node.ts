/**
 * Build nifra-svelte SSR bench for Node → dist-node/ (client.js + server-node.js).
 *
 *   bun run bench/ssr/nifra-svelte/build-node.ts
 */
import { mkdirSync, rmSync } from "node:fs"
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"

const dir = import.meta.dir
const dist = `${dir}/dist-node`
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const define = { "process.env.NODE_ENV": '"production"' }
const nodeSourceConditions = ["bun", "svelte", "node"]

const client = await Bun.build({
  entrypoints: [`${dir}/client.ts`],
  outdir: dist,
  target: "browser",
  conditions: ["bun", "browser"],
  plugins: [svelteBunPlugin("dom")],
  naming: "client.js",
  minify: true,
  define,
})

const srv = await Bun.build({
  entrypoints: [`${dir}/server-node.ts`],
  outdir: dist,
  target: "node",
  conditions: nodeSourceConditions,
  plugins: [svelteBunPlugin("ssr")],
  minify: true,
  define,
})

for (const r of [client, srv]) {
  if (!r.success) {
    for (const log of r.logs) console.error(log)
    process.exit(1)
  }
}
console.log("Node bench build → bench/ssr/nifra-svelte/dist-node")

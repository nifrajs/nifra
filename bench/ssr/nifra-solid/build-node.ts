/**
 * Build nifra-solid SSR bench for Node → dist-node/ (client.js + server-node.js).
 *
 *   bun run bench/ssr/nifra-solid/build-node.ts
 */
import { mkdirSync, rmSync } from "node:fs"
import { solidBunPlugin } from "@nifrajs/web-solid"

const dir = import.meta.dir
const dist = `${dir}/dist-node`
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const define = { "process.env.NODE_ENV": '"production"' }
const nodeSourceConditions = ["bun", "solid", "node"]

const client = await Bun.build({
  entrypoints: [`${dir}/client.ts`],
  outdir: dist,
  target: "browser",
  conditions: ["bun", "solid", "browser"],
  plugins: [solidBunPlugin("dom")],
  naming: "client.js",
  minify: true,
  define,
})

const srv = await Bun.build({
  entrypoints: [`${dir}/server-node.ts`],
  outdir: dist,
  target: "node",
  conditions: nodeSourceConditions,
  plugins: [solidBunPlugin("ssr")],
  minify: true,
  define,
})

for (const r of [client, srv]) {
  if (!r.success) {
    for (const log of r.logs) console.error(log)
    process.exit(1)
  }
}
console.log("Node bench build → bench/ssr/nifra-solid/dist-node")

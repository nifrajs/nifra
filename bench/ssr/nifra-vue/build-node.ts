/**
 * Build nifra-vue SSR bench for Node → dist-node/ (client.js + server-node.js).
 *
 *   bun run bench/ssr/nifra-vue/build-node.ts
 */
import { mkdirSync, rmSync } from "node:fs"

const dir = import.meta.dir
const dist = `${dir}/dist-node`
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const define = {
  "process.env.NODE_ENV": '"production"',
  __VUE_OPTIONS_API__: "true",
  __VUE_PROD_DEVTOOLS__: "false",
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
}
const nodeSourceConditions = ["bun", "node"]

const client = await Bun.build({
  entrypoints: [`${dir}/client.ts`],
  outdir: dist,
  target: "browser",
  conditions: ["bun", "browser"],
  naming: "client.js",
  minify: true,
  define,
})

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
console.log("Node bench build → bench/ssr/nifra-vue/dist-node")

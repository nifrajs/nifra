import { mkdirSync, rmSync } from "node:fs"

const dir = import.meta.dir
const dist = `${dir}/dist-node`
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
const define = { "process.env.NODE_ENV": '"production"' }
const client = await Bun.build({
  entrypoints: [`${dir}/../nifra/client.ts`],
  outdir: dist,
  target: "browser",
  conditions: ["bun", "browser"],
  naming: "client.js",
  minify: true,
  define,
})
const server = await Bun.build({
  entrypoints: [`${dir}/server-node.ts`],
  outdir: dist,
  target: "node",
  conditions: ["node"],
  minify: true,
  define,
})
for (const result of [client, server]) {
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}

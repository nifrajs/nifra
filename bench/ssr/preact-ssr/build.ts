import { mkdirSync, rmSync } from "node:fs"

const dir = import.meta.dir
const dist = `${dir}/dist`
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const client = await Bun.build({
  entrypoints: [`${dir}/src/client.ts`],
  outdir: dist,
  target: "browser",
  naming: "client.js",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
})

const srv = await Bun.build({
  entrypoints: [`${dir}/src/server.ts`],
  outdir: dist,
  target: "node",
  naming: "server.js",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
})

for (const r of [client, srv]) {
  if (!r.success) {
    for (const log of r.logs) console.error(log)
    process.exit(1)
  }
}

import { buildClient } from "@nifrajs/web/build"

const dir = import.meta.dir
const dist = `${dir}/dist`
const define = { "process.env.NODE_ENV": '"production"' }

const manifest = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: dist,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define,
})

const server = await Bun.build({
  entrypoints: [`${dir}/server.ts`],
  outdir: dir,
  target: "bun",
  conditions: ["bun"],
  naming: "server-bun.js",
  minify: true,
  define,
})

if (!server.success) {
  for (const log of server.logs) console.error(log)
  process.exit(1)
}

console.log("built", manifest.entry, ...server.outputs.map((o) => o.path))

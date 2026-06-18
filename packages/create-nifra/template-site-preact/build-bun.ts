// Build for Bun (nifra's flagship runtime) → dist-bun/ (server-bun.js + client assets).
// `bun run build:bun`. Run: `bun dist-bun/server-bun.js`.
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"

const dir = import.meta.dir
const dist = `${dir}/dist-bun`
rmSync(dist, { recursive: true, force: true })
mkdirSync(`${dist}/assets`, { recursive: true })

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dist}/assets`,
  clientModule: "@nifrajs/web-preact/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/server-bun.ts`,
  outDir: `${dir}/.build-bun`,
  target: "bun",
  clientEntry: client.entry,
})
cpSync(worker, `${dist}/server-bun.js`)
rmSync(`${dir}/.build-bun`, { recursive: true, force: true })
console.log("Bun output → dist-bun (run: bun dist-bun/server-bun.js)")

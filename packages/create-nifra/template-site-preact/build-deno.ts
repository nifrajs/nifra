// Build for Deno → dist-deno/ (server-deno.js + client assets). `bun run build:deno`.
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"

const dir = import.meta.dir
const dist = `${dir}/dist-deno`
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
  serverEntry: `${dir}/server-deno.ts`,
  outDir: `${dir}/.build-deno`,
  clientEntry: client.entry,
})
cpSync(worker, `${dist}/server-deno.js`)
rmSync(`${dir}/.build-deno`, { recursive: true, force: true })
console.log("Deno output → dist-deno (run: deno run -A dist-deno/server-deno.js)")

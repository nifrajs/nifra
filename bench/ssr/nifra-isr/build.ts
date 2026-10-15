/**
 * Build the ISR app for both runtimes: the client bundle into dist/assets/, then each server entry
 * through buildServer, which generates ./server-manifest from routes/ (the docs' custom-server path).
 */
import { rmSync } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"

const dir = import.meta.dir
const routesDir = `${dir}/routes`
const dist = `${dir}/dist`
rmSync(dist, { recursive: true, force: true })

const client = await buildClient({
  routesDir,
  outDir: `${dist}/assets`,
  clientModule: "@nifrajs/web-react/client",
  define: { "process.env.NODE_ENV": '"production"' },
})
for (const target of ["bun", "node"] as const) {
  await buildServer({
    routesDir,
    serverEntry: `${dir}/server-${target}.ts`,
    outDir: dist,
    clientEntry: client.entry,
    target,
  })
}
console.log("built", client.entry, `${dist}/server-bun.js`, `${dist}/server-node.js`)

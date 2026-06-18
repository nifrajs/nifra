// Build for the disk-less edge: (1) buildClient → public/assets (served by Workers Assets),
// (2) buildServer → dist-server/worker.js (a self-contained worker: static-import manifest +
// createWebApp, bundled with edge conditions). `wrangler.toml`'s `main` points at the worker.
//   bun run examples/workers-ssr-react/build.ts && (cd examples/workers-ssr-react && bunx wrangler dev)
import { buildClient, buildServer } from "@nifrajs/web/build"

const dir = import.meta.dir

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dir}/public/assets`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})

const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/worker.ts`,
  outDir: `${dir}/dist-server`,
  clientEntry: client.entry,
})

console.log("client entry:", client.entry)
console.log("worker bundle:", worker)

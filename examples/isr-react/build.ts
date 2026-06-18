// Build the ISR demo: (1) buildClient → public/assets (the content-hashed client bundle, served at
// /assets/* by the Bun server and by Workers Assets on the edge), and (2) buildServer →
// dist-server/worker.js (the self-contained edge worker — see worker.ts + wrangler.toml). ISR is the
// *dynamic* alternative to SSG, so there's no prerender step.
//   bun run examples/isr-react/build.ts
//   bun examples/isr-react/server.ts                      # Bun, in-memory store
//   (cd examples/isr-react && bunx wrangler dev)           # workerd, KV store (local)
import { buildClient, buildServer } from "@nifrajs/web/build"

const dir = import.meta.dir

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dir}/public/assets`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
console.log("client entry:", client.entry)

// The edge worker bundle (static-import route manifest + the baked client entry URL), for wrangler.
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/worker.ts`,
  outDir: `${dir}/dist-server`,
  clientEntry: client.entry,
})
console.log("worker bundle:", worker)

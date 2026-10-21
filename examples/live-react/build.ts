// Build the live demo's client bundle into public/assets.
//   bun run examples/live-react/build.ts
//   bun examples/live-react/server.ts
import { buildClient } from "@nifrajs/web/build"

const dir = import.meta.dir

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dir}/public/assets`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
  // The entry sends route loads through the live endpoints; `{}` is the runtime's defaults. A runtime
  // that moves them hands its `clientEntry` here instead.
  live: {},
})
console.log("client entry:", client.entry)

// One app, five runtimes. buildClient once → public/assets (served by the platform on edge, from
// disk on Node/Deno). buildServer per entry → a self-contained bundle: the edge runtimes (Cloudflare,
// Vercel, Deno/Deno Deploy) share the default `browser` target; Node uses `target: "node"`. Add
// `lazy: true` to any buildServer call for per-route code-split chunks (see README).
//   bun run examples/portable-ssr-react/build.ts
import { buildClient, buildServer } from "@nifrajs/web/build"

const dir = import.meta.dir

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dir}/public/assets`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
const common = { routesDir: `${dir}/routes`, clientEntry: client.entry }

await buildServer({
  ...common,
  serverEntry: `${dir}/cloudflare.ts`,
  outDir: `${dir}/dist/cloudflare`,
})
await buildServer({ ...common, serverEntry: `${dir}/vercel.ts`, outDir: `${dir}/dist/vercel` })
await buildServer({ ...common, serverEntry: `${dir}/deno.ts`, outDir: `${dir}/dist/deno` })
await buildServer({
  ...common,
  serverEntry: `${dir}/node.ts`,
  outDir: `${dir}/dist/node`,
  target: "node",
})

console.log("client entry:", client.entry)
console.log("built server bundles: cloudflare, vercel, deno, node")

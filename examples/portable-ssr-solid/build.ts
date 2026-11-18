// The same five-runtime build as portable-ssr-react, on Solid. buildClient uses solidBunPlugin("dom")
// buildServer uses solidBunPlugin("ssr") - its built-in shim pins solid-js and @solidjs/web to their
// server builds on the edge (browser) targets, and the `node` condition resolves them on Node. One
// bundle per runtime.
//   bun run build && bun run examples/portable-ssr-solid/build.ts
import { buildClient, buildServer } from "@nifrajs/web/build"
import { solidBunPlugin } from "@nifrajs/web-solid/plugin"

const dir = import.meta.dir

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dir}/public/assets`,
  clientModule: "@nifrajs/web-solid/client",
  plugins: [solidBunPlugin("dom")],
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
const edge = {
  routesDir: `${dir}/routes`,
  clientEntry: client.entry,
  plugins: [solidBunPlugin("ssr")],
  conditions: ["workerd", "edge-light", "browser"],
}

await buildServer({
  ...edge,
  serverEntry: `${dir}/cloudflare.ts`,
  outDir: `${dir}/dist/cloudflare`,
})
await buildServer({ ...edge, serverEntry: `${dir}/vercel.ts`, outDir: `${dir}/dist/vercel` })
await buildServer({ ...edge, serverEntry: `${dir}/deno.ts`, outDir: `${dir}/dist/deno` })
await buildServer({
  routesDir: `${dir}/routes`,
  clientEntry: client.entry,
  plugins: [solidBunPlugin("ssr")],
  serverEntry: `${dir}/node.ts`,
  outDir: `${dir}/dist/node`,
  target: "node",
  conditions: ["node"], // node → the Solid runtime's server build (no edge shim on this target)
})

console.log("client entry:", client.entry)
console.log("built server bundles: cloudflare, vercel, deno, node")

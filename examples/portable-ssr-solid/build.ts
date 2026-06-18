// The same five-runtime build as portable-ssr-react, on Solid. buildClient uses solidBunPlugin("dom")
// (+ the `solid` condition); buildServer uses solidBunPlugin("ssr") — its built-in shim pins
// solid-js/web to its server build on the edge (browser) targets, and the `solid`/`node` conditions
// resolve it on Node. One bundle per runtime.
//   bun run build && bun run examples/portable-ssr-solid/build.ts
import { buildClient, buildServer } from "@nifrajs/web/build"
import { solidBunPlugin } from "@nifrajs/web-solid"

const dir = import.meta.dir

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dir}/public/assets`,
  clientModule: "@nifrajs/web-solid/client",
  plugins: [solidBunPlugin("dom")],
  conditions: ["bun", "solid", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
const edge = {
  routesDir: `${dir}/routes`,
  clientEntry: client.entry,
  plugins: [solidBunPlugin("ssr")],
  conditions: ["workerd", "edge-light", "solid", "browser"],
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
  conditions: ["node", "solid"], // node → solid-js/web's server build (no edge shim on this target)
})

console.log("client entry:", client.entry)
console.log("built server bundles: cloudflare, vercel, deno, node")

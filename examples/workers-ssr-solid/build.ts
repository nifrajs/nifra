// Build for the disk-less edge (Solid): buildClient → public/assets (Solid `dom` transform), then
// buildServer → dist-server/worker.js (Solid `ssr` transform; buildServer's shim points
// `solid-js/web` at its SERVER runtime). `wrangler.toml`'s `main` points at the worker.
//   bun run examples/workers-ssr-solid/build.ts && (cd examples/workers-ssr-solid && bunx wrangler dev)
import { buildClient, buildServer } from "@nifrajs/web/build"
import { solidBunPlugin } from "@nifrajs/web-solid/plugin"

const dir = import.meta.dir

const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dir}/public/assets`,
  // The example has no hand-authored statics, so the default `./public` (relative to cwd) must not claim the output.
  publicDir: false,
  clientModule: "@nifrajs/web-solid/client",
  plugins: [solidBunPlugin("dom")],
  conditions: ["bun", "browser"],
  // Match buildServer's production define: Solid's dev vs prod builds generate DIFFERENT hydration
  // keys, so the client and server must agree or hydration mismatches ("00" vs "0").
  define: { "process.env.NODE_ENV": '"production"' },
})

const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/worker.ts`,
  outDir: `${dir}/dist-server`,
  clientEntry: client.entry,
  plugins: [solidBunPlugin("ssr")],
  // buildServer's shim pins solid-js and @solidjs/web to their server builds (the `worker` condition would do it too,
  // but it segfaults Bun.build 1.3.14), so plain edge conditions suffice here.
  conditions: ["workerd", "edge-light", "browser"],
})

console.log("client entry:", client.entry)
console.log("worker bundle:", worker)

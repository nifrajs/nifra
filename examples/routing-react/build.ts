// Build the client bundle via @nifrajs/web/build: discover routes → codegen → Bun.build, now
// content-hashed + minified, writing dist/manifest.json (read by server.ts). React's JSX is
// Bun-native, so no plugin (just the production NODE_ENV define). Then PRERENDER (SSG) — static
// routes that opt in (`export const prerender = true`) + dynamic routes that enumerate via
// `getStaticPaths` — to static HTML, and write a prerendered.json deploy manifest.
//   bun run examples/routing-react/build.ts
import { writeFileSync } from "node:fs"
import { buildClient, cloudflarePagesRoutes, prerenderRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"

const dist = `${import.meta.dir}/dist`

const manifest = await buildClient({
  routesDir: `${import.meta.dir}/routes`,
  outDir: dist,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
console.log("built", manifest.entry)

// SSG: dynamic-import the app AFTER buildClient (so server.ts reads the fresh manifest.json → the
// prerendered HTML references the just-built hashed entry), then prerender opted-in static routes.
const { app } = await import("./server")
const { prerendered, skipped, fallbacks } = await prerenderRoutes({
  app,
  routes: discoverRoutes(`${import.meta.dir}/routes`).routes,
  outDir: dist,
})
for (const p of prerendered) console.log(`prerendered ${p.path} → dist/${p.file} (${p.bytes} B)`)
if (prerendered.length === 0) console.log("prerendered: none (no route opted in)")
// Skipped is expected/noisy (every non-opted route) — only surface render FAILURES.
for (const s of skipped)
  if (s.reason.includes("HTTP")) console.warn(`prerender skipped ${s.path}: ${s.reason}`)

// Deploy manifest: the prerendered request paths + per-dynamic-route fallback.
const paths = prerendered.map((p) => p.path)
writeFileSync(`${dist}/prerendered.json`, `${JSON.stringify({ paths, fallbacks }, null, 2)}\n`)

// Cloudflare Pages hybrid routing: serve the prerendered docs + their _data.json + assets from the
// CDN; everything else falls through to the SSR _worker.js. (Illustrative here — this example runs
// on Bun, not Pages — but it's the turnkey output for a Pages deploy.)
writeFileSync(
  `${dist}/_routes.json`,
  `${JSON.stringify(cloudflarePagesRoutes({ prerendered: paths }), null, 2)}\n`,
)

/**
 * Build the site for Cloudflare Pages. Output: site/dist/ — a `_worker.js` (the Nifra SSR worker)
 * + the content-hashed client bundle under /assets/*. Deploy with `wrangler pages deploy dist`.
 *
 *   bun run site/build.ts
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mdxBunPlugin } from "@nifrajs/content/mdx"
import { buildClient, buildServer } from "@nifrajs/web/build"
import { writeFrameworksArtifact } from "./build-frameworks"
import { buildSiteIslands } from "./build-islands"

const dir = import.meta.dir
const dist = `${dir}/dist`

// `.mdx` routes (e.g. /docs/content) compile to React components — Nifra dogfoods its own MDX support.
const mdx = mdxBunPlugin({ jsxImportSource: "react" })

rmSync(dist, { recursive: true, force: true })
mkdirSync(`${dist}/assets`, { recursive: true })

// (0) The /frameworks live demo: render the shared catalog through all five UI adapters → five HTML
// fragments + five real client hydration bundles (dist/assets/fw-*.client.js), and measure each bundle's
// gzip size. Runs BEFORE the React client/server builds because the /frameworks route imports the JSON
// artifact this writes (../data/frameworks-demo.json). Each framework is its own isolated Bun.build, so
// Solid's Babel plugin / Svelte's compiler don't leak onto the React/Preact .tsx — see build-frameworks.ts.
await writeFrameworksArtifact({ outDir: `${dist}/assets` })

// (1) Client bundle → dist/assets/* (served by Pages at /assets/*).
const client = await buildClient({
  routesDir: `${dir}/routes`,
  outDir: `${dist}/assets`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [mdx],
})
await buildSiteIslands({ outDir: `${dist}/assets` })

// (2) SSR worker (edge conditions: workerd/edge-light) → a self-contained `_worker.js`.
const { worker } = await buildServer({
  routesDir: `${dir}/routes`,
  serverEntry: `${dir}/_worker.ts`,
  outDir: `${dir}/dist-server`,
  clientEntry: client.entry,
  plugins: [mdx],
})

// (3) Assemble the Pages output dir.
cpSync(worker, `${dist}/_worker.js`)
cpSync(`${dir}/public/favicon.png`, `${dist}/assets/favicon.png`)
cpSync(`${dir}/public/apple-touch-icon.png`, `${dist}/assets/apple-touch-icon.png`)
cpSync(`${dir}/public/logo-mark.png`, `${dist}/assets/logo-mark.png`)
cpSync(`${dir}/public/og.jpg`, `${dist}/assets/og.jpg`)
cpSync(`${dir}/public/background.png`, `${dist}/assets/background.png`)
cpSync(`${dir}/public/nifra-bot-avatar.png`, `${dist}/assets/nifra-bot-avatar.png`)
// AI-readable docs (llmstxt.org): the index + the full single-file reference, served at the site root
// so an LLM can fetch /llms.txt and /llms-full.txt. Canonical source is the repo root (one per repo).
cpSync(`${dir}/../llms.txt`, `${dist}/llms.txt`)
cpSync(`${dir}/../llms-full.txt`, `${dist}/llms-full.txt`)
// The generated library API reference (every public export + signature + doc), served at /api-reference.md.
cpSync(`${dir}/../api-reference.md`, `${dist}/api-reference.md`)
// The verified-example corpus, served at /examples.json — the `/mcp` worker route fetches this (and
// /llms-full.txt) same-origin to back nifra_example / nifra_docs without bundling. See _worker.ts.
cpSync(`${dir}/../packages/cli/docs/examples.json`, `${dist}/examples.json`)
// The type-signature corpus, served at /types.json — the `/mcp` worker route fetches it same-origin to
// back nifra_types (the exact TypeScript of every @nifrajs/* export). See _worker.ts.
cpSync(`${dir}/../packages/cli/docs/types.json`, `${dist}/types.json`)
rmSync(`${dir}/dist-server`, { recursive: true, force: true })

// (4) `_routes.json` — exclude paths the Worker should NOT handle so Pages serves them statically from
// its CDN (a `_worker.js` is otherwise invoked for every path): the client bundle under /assets/*, plus
// the static llms.txt / llms-full.txt. Everything else falls through to the Worker (SSR).
writeFileSync(
  `${dist}/_routes.json`,
  `${JSON.stringify(
    {
      version: 1,
      include: ["/*"],
      exclude: [
        "/assets/*",
        "/llms.txt",
        "/llms-full.txt",
        "/api-reference.md",
        "/examples.json",
        "/types.json",
      ],
    },
    null,
    2,
  )}\n`,
)

console.log(
  `Cloudflare Pages output: site/dist (_worker.js + _routes.json + client ${client.entry})`,
)

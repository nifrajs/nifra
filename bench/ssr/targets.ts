/**
 * SSR benchmark targets — grouped by UI runtime. Each group has Table A (uncached) and Table B
 * (cacheable SSG; React also has ISR). See SSR-BENCHMARKS.md before comparing across tables.
 */
import type { SsrBenchTarget } from "./harness.ts"

const BENCH_DIR = import.meta.dir

const INSTALL = "(test -d node_modules || bun install --silent)"
const NEXT_STANDALONE_BUILD = `${INSTALL} && bunx next build && rm -rf .next/standalone/.next/static && cp -r .next/static .next/standalone/.next/static`
const NODE_HOST = { HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1" } as const
const CATALOG_HTML = { rootId: "root", text: "Item 50", liCount: 50 } as const

const staticServe = (dist: string, port: number): SsrBenchTarget => ({
  name: "",
  runtime: "bun",
  build: [],
  serve: ["bun", "run", `${BENCH_DIR}/static-server.ts`],
  serveEnv: { DIST: dist },
  port,
  validate: CATALOG_HTML,
})

function nifraStatic(name: string, subdir: string, port: number): SsrBenchTarget {
  return {
    ...staticServe(`${BENCH_DIR}/${subdir}/dist`, port),
    name,
    build: ["bun", "run", `${BENCH_DIR}/${subdir}/build.ts`],
  }
}

/** Same nifra app on Node (@nifrajs/node) — fair same-runtime row vs meta-frameworks on Node. */
function nifraNode(name: string, subdir: string, port: number): SsrBenchTarget {
  return {
    name,
    runtime: "node",
    build: ["bun", "run", `${BENCH_DIR}/${subdir}/build-node.ts`],
    serve: ["node", `${BENCH_DIR}/${subdir}/dist-node/server-node.js`],
    port,
    serveEnv: NODE_HOST,
    validate: CATALOG_HTML,
  }
}

/** Nifra on Bun, served as a production bundle so it is comparable to the Node bundle rows. */
function nifraBun(name: string, subdir: string, port: number): SsrBenchTarget {
  return {
    name,
    runtime: "bun",
    build: ["bun", "run", `${BENCH_DIR}/${subdir}/build.ts`],
    serve: ["bun", `${BENCH_DIR}/${subdir}/server-bun.js`],
    port,
    validate: CATALOG_HTML,
  }
}

/** React — uncached SSR + meta-frameworks. */
export const REACT_TABLE_A: readonly SsrBenchTarget[] = [
  nifraBun("nifra+react", "nifra", 4300),
  {
    name: "nifra+react (node)",
    runtime: "node",
    build: ["bun", "run", `${BENCH_DIR}/nifra/build-node.ts`],
    serve: ["node", `${BENCH_DIR}/nifra/dist-node/server-node.js`],
    port: 4304,
    serveEnv: NODE_HOST,
    validate: CATALOG_HTML,
  },
  {
    name: "next (dynamic)",
    runtime: "node",
    cwd: `${BENCH_DIR}/next`,
    build: ["sh", "-c", NEXT_STANDALONE_BUILD],
    serve: ["node", ".next/standalone/server.js"],
    port: 4301,
    serveEnv: NODE_HOST,
  },
  {
    name: "remix",
    runtime: "node",
    cwd: `${BENCH_DIR}/remix`,
    build: ["sh", "-c", `${INSTALL} && bunx react-router build`],
    serve: ["./node_modules/.bin/react-router-serve", "./build/server/index.js"],
    port: 4302,
    serveEnv: NODE_HOST,
  },
]

export const REACT_TABLE_B: readonly SsrBenchTarget[] = [
  nifraStatic("nifra+react (SSG)", "nifra-static", 4310),
  {
    name: "next (static)",
    runtime: "node",
    cwd: `${BENCH_DIR}/next-static`,
    build: ["sh", "-c", NEXT_STANDALONE_BUILD],
    serve: ["node", ".next/standalone/server.js"],
    port: 4311,
    serveEnv: NODE_HOST,
  },
  {
    name: "nifra+react (ISR)",
    runtime: "bun",
    build: ["bun", "run", `${BENCH_DIR}/nifra-isr/build.ts`],
    serve: ["bun", `${BENCH_DIR}/nifra-isr/server-bun.js`],
    port: 4313,
    warmupCache: true,
    validate: CATALOG_HTML,
  },
  {
    name: "next (ISR)",
    runtime: "node",
    cwd: `${BENCH_DIR}/next-isr`,
    build: ["sh", "-c", NEXT_STANDALONE_BUILD],
    serve: ["node", ".next/standalone/server.js"],
    port: 4312,
    serveEnv: NODE_HOST,
    warmupCache: true,
  },
]

/** Solid — nifra vs SolidStart. */
export const SOLID_TABLE_A: readonly SsrBenchTarget[] = [
  nifraBun("nifra+solid", "nifra-solid", 4320),
  nifraNode("nifra+solid (node)", "nifra-solid", 4350),
  {
    name: "solidstart",
    runtime: "node",
    cwd: `${BENCH_DIR}/solidstart`,
    build: ["sh", "-c", `${INSTALL} && bunx vinxi build`],
    serve: ["node", ".output/server/index.mjs"],
    port: 4344,
    serveEnv: NODE_HOST,
  },
  {
    name: "solid-ssr",
    runtime: "node",
    cwd: `${BENCH_DIR}/solid-ssr`,
    build: ["bun", "run", "build.ts"],
    serve: ["node", "dist/server.js"],
    port: 4328,
    serveEnv: NODE_HOST,
    validate: CATALOG_HTML,
  },
]

export const SOLID_TABLE_B: readonly SsrBenchTarget[] = [
  nifraStatic("nifra+solid (SSG)", "nifra-solid-static", 4330),
  {
    name: "solidstart (static)",
    runtime: "node",
    cwd: `${BENCH_DIR}/solidstart-static`,
    build: ["sh", "-c", `${INSTALL} && bunx vinxi build`],
    serve: ["node", ".output/server/index.mjs"],
    port: 4334,
    serveEnv: NODE_HOST,
  },
]

/** Vue — nifra vs Nuxt. */
export const VUE_TABLE_A: readonly SsrBenchTarget[] = [
  nifraBun("nifra+vue", "nifra-vue", 4321),
  nifraNode("nifra+vue (node)", "nifra-vue", 4351),
  {
    name: "nuxt",
    runtime: "node",
    cwd: `${BENCH_DIR}/nuxt`,
    build: ["sh", "-c", `${INSTALL} && bunx nuxt build`],
    serve: ["node", ".output/server/index.mjs"],
    port: 4325,
    serveEnv: NODE_HOST,
  },
]

export const VUE_TABLE_B: readonly SsrBenchTarget[] = [
  nifraStatic("nifra+vue (SSG)", "nifra-vue-static", 4332),
  {
    name: "nuxt (static)",
    runtime: "node",
    cwd: `${BENCH_DIR}/nuxt-static`,
    build: ["sh", "-c", `${INSTALL} && bunx nuxt build`],
    serve: ["node", ".output/server/index.mjs"],
    port: 4335,
    serveEnv: NODE_HOST,
  },
]

/** Svelte — nifra vs SvelteKit. */
export const SVELTE_TABLE_A: readonly SsrBenchTarget[] = [
  nifraBun("nifra+svelte", "nifra-svelte", 4322),
  nifraNode("nifra+svelte (node)", "nifra-svelte", 4352),
  {
    name: "sveltekit",
    runtime: "node",
    cwd: `${BENCH_DIR}/sveltekit`,
    build: ["sh", "-c", `${INSTALL} && bunx vite build`],
    serve: ["node", "build/index.js"],
    port: 4326,
    serveEnv: NODE_HOST,
  },
]

export const SVELTE_TABLE_B: readonly SsrBenchTarget[] = [
  nifraStatic("nifra+svelte (SSG)", "nifra-svelte-static", 4333),
  {
    name: "sveltekit (static)",
    runtime: "node",
    cwd: `${BENCH_DIR}/sveltekit-static`,
    build: ["sh", "-c", `${INSTALL} && bunx vite build`],
    serve: ["node", "build/index.js"],
    port: 4336,
    serveEnv: NODE_HOST,
  },
]

/** Preact — nifra vs minimal Preact SSR (no maintained meta-framework). */
export const PREACT_TABLE_A: readonly SsrBenchTarget[] = [
  nifraBun("nifra+preact", "nifra-preact", 4323),
  nifraNode("nifra+preact (node)", "nifra-preact", 4353),
  {
    name: "preact-ssr",
    runtime: "node",
    cwd: `${BENCH_DIR}/preact-ssr`,
    build: ["bun", "run", "build.ts"],
    serve: ["node", "dist/server.js"],
    port: 4327,
    serveEnv: NODE_HOST,
    validate: CATALOG_HTML,
  },
]

export const PREACT_TABLE_B: readonly SsrBenchTarget[] = [
  nifraStatic("nifra+preact (SSG)", "nifra-preact-static", 4337),
]

export const ALL_TABLE_SECTIONS: readonly {
  readonly label: string
  readonly blurb: string
  readonly targets: readonly SsrBenchTarget[]
}[] = [
  {
    label: "React — Table A (uncached SSR)",
    blurb: "Per-request render. nifra+react (Bun + Node) vs next (dynamic) vs remix.",
    targets: REACT_TABLE_A,
  },
  {
    label: "React — Table B (cacheable)",
    blurb: "SSG + ISR (ISR rows cache-warmed before oha).",
    targets: REACT_TABLE_B,
  },
  {
    label: "Solid — Table A (uncached SSR)",
    blurb:
      "nifra+solid (Bun + Node) vs SolidStart + solid-ssr. Compare Node rows to Node rows only.",
    targets: SOLID_TABLE_A,
  },
  {
    label: "Solid — Table B (SSG)",
    blurb: "Build-time catalog; nifra prerender vs SolidStart prerender.",
    targets: SOLID_TABLE_B,
  },
  {
    label: "Vue — Table A (uncached SSR)",
    blurb: "nifra+vue (Bun + Node) vs Nuxt. Compare Node rows to Node rows only.",
    targets: VUE_TABLE_A,
  },
  {
    label: "Vue — Table B (SSG)",
    blurb: "nifra prerender vs Nuxt prerender route.",
    targets: VUE_TABLE_B,
  },
  {
    label: "Svelte — Table A (uncached SSR)",
    blurb: "nifra+svelte (Bun + Node) vs SvelteKit. Compare Node rows to Node rows only.",
    targets: SVELTE_TABLE_A,
  },
  {
    label: "Svelte — Table B (SSG)",
    blurb: "nifra prerender vs SvelteKit prerender=true.",
    targets: SVELTE_TABLE_B,
  },
  {
    label: "Preact — Table A (uncached SSR)",
    blurb: "nifra+preact (Bun + Node) vs preact-ssr. Compare Node rows to Node rows only.",
    targets: PREACT_TABLE_A,
  },
  {
    label: "Preact — Table B (SSG)",
    blurb: "nifra prerender only (no Preact meta-framework baseline).",
    targets: PREACT_TABLE_B,
  },
]

/**
 * SSR benchmark targets - grouped by UI runtime. Each group has Table A (dynamic SSR, no caching) and
 * Table B (SSG; React also has ISR). bench/ssr/README.md says what each row kind measures.
 */
import type { SsrBenchTarget } from "./harness.ts"

const BENCH_DIR = import.meta.dir
const NIFRA_CLI = `${BENCH_DIR}/../../packages/cli/src/cli.ts`

const INSTALL = "(test -d node_modules || bun install --silent)"
const NEXT_STANDALONE_BUILD = `${INSTALL} && bunx next build && rm -rf .next/standalone/.next/static && cp -r .next/static .next/standalone/.next/static`
const NODE_HOST = { HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1" } as const
const CATALOG_HTML = { rootId: "root", text: "Item 50", liCount: 50 } as const
// Comparators have no fixed hydration-root id; the harness checks the whole document instead, so
// every row - nifra and meta-framework alike - proves it server-rendered the same 50-item catalog.
const CATALOG_DOC = { text: "Item 50", liCount: 50 } as const

/**
 * A nifra app (`routes/` + a `.backend.ts` loader + `nifra.config.ts`) built by `nifra build --target
 * <runtime>` and served by the server.js it generates - what `nifra start` runs.
 */
function nifraApp(
  name: string,
  subdir: string,
  runtime: "bun" | "node",
  port: number,
): SsrBenchTarget {
  return {
    name,
    runtime,
    cwd: `${BENCH_DIR}/${subdir}`,
    build: ["bun", NIFRA_CLI, "build", "--target", runtime, "--out", `dist-${runtime}`],
    serve: [runtime, `dist-${runtime}/server.js`],
    port,
    validate: CATALOG_HTML,
  }
}

/** `renderPage` from a hand-written server: a raw Bun.serve handler, or the same handler on Node. */
function ownServer(
  name: string,
  subdir: string,
  runtime: "bun" | "node",
  port: number,
): SsrBenchTarget {
  return runtime === "bun"
    ? {
        name,
        runtime,
        kind: "own-server",
        build: ["bun", "run", `${BENCH_DIR}/${subdir}/build.ts`],
        serve: ["bun", `${BENCH_DIR}/${subdir}/server-bun.js`],
        port,
        validate: CATALOG_HTML,
      }
    : {
        name,
        runtime,
        kind: "own-server",
        build: ["bun", "run", `${BENCH_DIR}/${subdir}/build-node.ts`],
        serve: ["node", `${BENCH_DIR}/${subdir}/dist-node/server-node.js`],
        port,
        validate: CATALOG_HTML,
      }
}

/** The `nifra build --target static` output on a plain file server: what a CDN or static host does. */
function staticHost(name: string, subdir: string, port: number): SsrBenchTarget {
  return {
    name,
    runtime: "bun",
    kind: "static-host",
    cwd: `${BENCH_DIR}/${subdir}`,
    build: ["bun", NIFRA_CLI, "build", "--target", "static", "--out", "dist"],
    serve: ["bun", "run", `${BENCH_DIR}/static-server.ts`],
    serveEnv: { DIST: `${BENCH_DIR}/${subdir}/dist` },
    port,
    validate: CATALOG_HTML,
  }
}

/** React - nifra vs Next.js and React Router (Remix). */
export const REACT_TABLE_A: readonly SsrBenchTarget[] = [
  nifraApp("nifra+react", "nifra-app", "bun", 4300),
  nifraApp("nifra+react (node)", "nifra-app", "node", 4304),
  {
    name: "next (dynamic)",
    runtime: "node",
    cwd: `${BENCH_DIR}/next`,
    build: ["sh", "-c", NEXT_STANDALONE_BUILD],
    serve: ["node", ".next/standalone/server.js"],
    port: 4301,
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
  },
  {
    name: "remix",
    runtime: "node",
    cwd: `${BENCH_DIR}/remix`,
    build: ["sh", "-c", `${INSTALL} && bunx react-router build`],
    serve: ["./node_modules/.bin/react-router-serve", "./build/server/index.js"],
    port: 4302,
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
  },
  ownServer("nifra+react (own server)", "nifra", "bun", 4305),
  ownServer("nifra+react (own server, node)", "nifra", "node", 4306),
]

export const REACT_TABLE_B: readonly SsrBenchTarget[] = [
  nifraApp("nifra+react (SSG)", "nifra-static", "bun", 4310),
  nifraApp("nifra+react (SSG, node)", "nifra-static", "node", 4314),
  {
    name: "next (static)",
    runtime: "node",
    cwd: `${BENCH_DIR}/next-static`,
    build: ["sh", "-c", NEXT_STANDALONE_BUILD],
    serve: ["node", ".next/standalone/server.js"],
    port: 4311,
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
  },
  {
    name: "nifra+react (ISR)",
    runtime: "bun",
    build: ["bun", "run", `${BENCH_DIR}/nifra-isr/build.ts`],
    serve: ["bun", `${BENCH_DIR}/nifra-isr/dist/server-bun.js`],
    port: 4313,
    warmupCache: true,
    validate: CATALOG_HTML,
  },
  {
    name: "nifra+react (ISR, node)",
    runtime: "node",
    build: ["bun", "run", `${BENCH_DIR}/nifra-isr/build.ts`],
    serve: ["node", `${BENCH_DIR}/nifra-isr/dist/server-node.js`],
    port: 4315,
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
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
    warmupCache: true,
  },
  staticHost("nifra+react (SSG files, static host)", "nifra-static", 4316),
]

/** Solid - nifra vs SolidStart. */
export const SOLID_TABLE_A: readonly SsrBenchTarget[] = [
  nifraApp("nifra+solid", "nifra-solid-app", "bun", 4320),
  nifraApp("nifra+solid (node)", "nifra-solid-app", "node", 4350),
  {
    name: "solidstart",
    runtime: "node",
    cwd: `${BENCH_DIR}/solidstart`,
    build: ["sh", "-c", `${INSTALL} && bunx vinxi build`],
    serve: ["node", ".output/server/index.mjs"],
    port: 4344,
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
  },
  ownServer("nifra+solid (own server)", "nifra-solid", "bun", 4354),
  ownServer("nifra+solid (own server, node)", "nifra-solid", "node", 4355),
]

export const SOLID_TABLE_B: readonly SsrBenchTarget[] = [
  nifraApp("nifra+solid (SSG)", "nifra-solid-static", "bun", 4330),
  nifraApp("nifra+solid (SSG, node)", "nifra-solid-static", "node", 4360),
  {
    name: "solidstart (static)",
    runtime: "node",
    cwd: `${BENCH_DIR}/solidstart-static`,
    build: ["sh", "-c", `${INSTALL} && bunx vinxi build`],
    serve: ["node", ".output/server/index.mjs"],
    port: 4334,
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
  },
  staticHost("nifra+solid (SSG files, static host)", "nifra-solid-static", 4364),
]

/** Vue - nifra vs Nuxt. */
export const VUE_TABLE_A: readonly SsrBenchTarget[] = [
  nifraApp("nifra+vue", "nifra-vue-app", "bun", 4345),
  nifraApp("nifra+vue (node)", "nifra-vue-app", "node", 4351),
  {
    name: "nuxt",
    runtime: "node",
    cwd: `${BENCH_DIR}/nuxt`,
    build: ["sh", "-c", `${INSTALL} && bunx nuxt build`],
    serve: ["node", ".output/server/index.mjs"],
    port: 4325,
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
  },
  ownServer("nifra+vue (own server)", "nifra-vue", "bun", 4346),
  ownServer("nifra+vue (own server, node)", "nifra-vue", "node", 4347),
]

export const VUE_TABLE_B: readonly SsrBenchTarget[] = [
  nifraApp("nifra+vue (SSG)", "nifra-vue-static", "bun", 4332),
  nifraApp("nifra+vue (SSG, node)", "nifra-vue-static", "node", 4361),
  {
    name: "nuxt (static)",
    runtime: "node",
    cwd: `${BENCH_DIR}/nuxt-static`,
    build: ["sh", "-c", `${INSTALL} && bunx nuxt build`],
    serve: ["node", ".output/server/index.mjs"],
    port: 4335,
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
  },
  staticHost("nifra+vue (SSG files, static host)", "nifra-vue-static", 4365),
]

/** Svelte - nifra vs SvelteKit. */
export const SVELTE_TABLE_A: readonly SsrBenchTarget[] = [
  nifraApp("nifra+svelte", "nifra-svelte-app", "bun", 4348),
  nifraApp("nifra+svelte (node)", "nifra-svelte-app", "node", 4352),
  {
    name: "sveltekit",
    runtime: "node",
    cwd: `${BENCH_DIR}/sveltekit`,
    build: ["sh", "-c", `${INSTALL} && bunx vite build`],
    serve: ["node", "build/index.js"],
    port: 4326,
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
  },
  ownServer("nifra+svelte (own server)", "nifra-svelte", "bun", 4349),
  ownServer("nifra+svelte (own server, node)", "nifra-svelte", "node", 4356),
]

export const SVELTE_TABLE_B: readonly SsrBenchTarget[] = [
  nifraApp("nifra+svelte (SSG)", "nifra-svelte-static", "bun", 4333),
  nifraApp("nifra+svelte (SSG, node)", "nifra-svelte-static", "node", 4362),
  {
    name: "sveltekit (static)",
    runtime: "node",
    cwd: `${BENCH_DIR}/sveltekit-static`,
    build: ["sh", "-c", `${INSTALL} && bunx vite build`],
    serve: ["node", "build/index.js"],
    port: 4336,
    validate: CATALOG_DOC,
    serveEnv: NODE_HOST,
  },
  staticHost("nifra+svelte (SSG files, static host)", "nifra-svelte-static", 4366),
]

/** Preact - nifra only (no maintained Preact meta-framework exists to bench). */
export const PREACT_TABLE_A: readonly SsrBenchTarget[] = [
  nifraApp("nifra+preact", "nifra-preact-app", "bun", 4323),
  nifraApp("nifra+preact (node)", "nifra-preact-app", "node", 4353),
  {
    // The renderer ceiling: preact-render-to-string on a bare node server - no framework.
    name: "preact-ssr",
    runtime: "node",
    cwd: `${BENCH_DIR}/preact-ssr`,
    build: ["sh", "-c", `${INSTALL} && bun run build.ts`],
    serve: ["node", "dist/server.js"],
    port: 4327,
    serveEnv: NODE_HOST,
    validate: CATALOG_HTML,
  },
  ownServer("nifra+preact (own server)", "nifra-preact", "bun", 4357),
  ownServer("nifra+preact (own server, node)", "nifra-preact", "node", 4358),
]

export const PREACT_TABLE_B: readonly SsrBenchTarget[] = [
  nifraApp("nifra+preact (SSG)", "nifra-preact-static", "bun", 4337),
  nifraApp("nifra+preact (SSG, node)", "nifra-preact-static", "node", 4363),
  staticHost("nifra+preact (SSG files, static host)", "nifra-preact-static", 4367),
]

export interface SsrTableSection {
  readonly label: string
  readonly blurb: string
  /** Every row's paired ratio is against this one, measured in the same rounds. */
  readonly baseline: string
  readonly targets: readonly SsrBenchTarget[]
}

export const ALL_TABLE_SECTIONS: readonly SsrTableSection[] = [
  {
    label: "React - Table A (uncached SSR)",
    blurb:
      "Per-request render. nifra app (Bun + Node) vs Next.js (dynamic) and React Router on Node. Compare Node rows to Node rows.",
    baseline: "next (dynamic)",
    targets: REACT_TABLE_A,
  },
  {
    label: "React - Table B (cacheable)",
    blurb: "SSG + ISR (ISR rows cache-warmed before oha).",
    baseline: "next (static)",
    targets: REACT_TABLE_B,
  },
  {
    label: "Solid - Table A (uncached SSR)",
    blurb: "nifra app (Bun + Node) vs SolidStart. Compare Node rows to Node rows only.",
    baseline: "solidstart",
    targets: SOLID_TABLE_A,
  },
  {
    label: "Solid - Table B (SSG)",
    blurb: "Build-time catalog; nifra prerender vs SolidStart prerender.",
    baseline: "solidstart (static)",
    targets: SOLID_TABLE_B,
  },
  {
    label: "Vue - Table A (uncached SSR)",
    blurb: "nifra app (Bun + Node) vs Nuxt. Compare Node rows to Node rows only.",
    baseline: "nuxt",
    targets: VUE_TABLE_A,
  },
  {
    label: "Vue - Table B (SSG)",
    blurb: "nifra prerender vs Nuxt prerender route.",
    baseline: "nuxt (static)",
    targets: VUE_TABLE_B,
  },
  {
    label: "Svelte - Table A (uncached SSR)",
    blurb: "nifra app (Bun + Node) vs SvelteKit. Compare Node rows to Node rows only.",
    baseline: "sveltekit",
    targets: SVELTE_TABLE_A,
  },
  {
    label: "Svelte - Table B (SSG)",
    blurb: "nifra prerender vs SvelteKit prerender=true.",
    baseline: "sveltekit (static)",
    targets: SVELTE_TABLE_B,
  },
  {
    label: "Preact - Table A (uncached SSR)",
    blurb:
      "nifra app (Bun + Node); no Preact meta-framework exists to bench against. preact-ssr is the raw render-to-string ceiling (no framework).",
    baseline: "preact-ssr",
    targets: PREACT_TABLE_A,
  },
  {
    label: "Preact - Table B (SSG)",
    blurb: "nifra prerender only (no Preact meta-framework baseline).",
    baseline: "nifra+preact (SSG files, static host)",
    targets: PREACT_TABLE_B,
  },
]

/**
 * Cloudflare Workers cold-start benchmark - `toFetchHandler(app)` (nifra) vs a Workers-native Hono
 * app vs a hand-written `fetch` handler. One number that matters on the edge:
 *
 *   COLD - the isolate's first breath: parse+compile the single-file Worker bundle, run its module
 *          init, answer the first request. Measured in a FRESH V8 process per sample (a warm process
 *          cannot re-measure a first-ever compile), median of N. Split into compile / init /
 *          first-request so a regression points at its cause.
 *
 * Why this bench exists separately from bench/lambda: on Lambda the ~11 ms Node bootstrap dominates
 * and masks a framework's parse cost, so a bigger bundle barely moves the total. Workers has NO such
 * bootstrap - the isolate parses your script and runs, so bundle size lands closer to the surface.
 * This is where nifra's larger bundle can actually cost cold latency, and this bench makes it visible.
 *
 * Every row is BUNDLED with `Bun.build({ target: "browser", conditions: ["workerd", ...] })` - a
 * single-file Worker is how a Worker is actually shipped, and identical bundling keeps the parse fair.
 * This measures the FRAMEWORK on this box in a V8 vm context, not Cloudflare's network. Treat the
 * absolute cold numbers as a lower bound and read the DELTA between rows. See _measure.mjs for limits.
 *
 *   bun run bench/workers/run.ts
 *   BENCH_COLD_RUNS=9 bun run bench/workers/run.ts
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { gzipSync } from "bun"

const here = dirname(Bun.fileURLToPath(import.meta.url))
const OUT_DIR = join(here, "dist")
mkdirSync(OUT_DIR, { recursive: true })

const envInt = (name: string, dflt: number, min = 1): number => {
  const n = Bun.env[name] === undefined ? Number.NaN : Number(Bun.env[name])
  return Number.isInteger(n) && n >= min ? n : dflt
}
const COLD_RUNS = envInt("BENCH_COLD_RUNS", 7)

// Three nifra rows below the full server scope the compact-edge refactor, heaviest to lightest:
//   nifra-dx     - SHELL (worker-nifra-dx.ts + _edge-server.ts): the moat AND the real
//                  `server().get().post()` builder DX. Prices what keeping the API costs over the
//                  hand-wired kernel - the number Phase-1's decision gate turns on.
//   nifra-kernel - PROTOTYPE (worker-nifra-kernel.ts): the same moat, but dispatch hand-wired against
//                  the raw router - so it does NOT charge for the builder API.
//   nifra-edge   - SPIKE (worker-nifra-edge.ts): the real router, NO Server class, NO defaults. The
//                  absolute floor - upper bound on savings, lower bound on cold time.
//   nifra-edge-pkg - SHIPPED (worker-nifra-edge-pkg.ts): the real published `@nifrajs/edge` package.
//                  What the compact server actually costs once it keeps the full trust boundary
//                  (bounded body, proto-guard, byte-parity envelopes) the spike row dropped.
// Ordered full -> dx -> kernel -> spike -> shipped so each step's gap against `nifra` is visible.
const FRAMEWORKS = [
  "nifra",
  "nifra-dx",
  "nifra-kernel",
  "nifra-edge",
  "nifra-edge-pkg",
  "hono",
  "hono-quick",
  "hono-tiny",
  "raw",
] as const
type Framework = (typeof FRAMEWORKS)[number]

interface ColdSample {
  readonly compileMs: number
  readonly initMs: number
  readonly firstFetchMs: number
  readonly coldMs: number
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}
function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined
}

/** Parse a child's one-line JSON at the trust boundary - subprocess output, validate the shape. */
function parseCold(raw: string): ColdSample {
  const json: unknown = JSON.parse(raw)
  const compileMs = finiteNumber(field(json, "compileMs"))
  const initMs = finiteNumber(field(json, "initMs"))
  const firstFetchMs = finiteNumber(field(json, "firstFetchMs"))
  const coldMs = finiteNumber(field(json, "coldMs"))
  if (
    compileMs === undefined ||
    initMs === undefined ||
    firstFetchMs === undefined ||
    coldMs === undefined
  ) {
    throw new Error(`unexpected cold JSON: ${raw.slice(0, 200)}`)
  }
  return { compileMs, initMs, firstFetchMs, coldMs }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1] ?? 0
}

async function bundle(framework: Framework): Promise<number> {
  const entry = join(here, `worker-${framework}.ts`)
  const outfile = join(OUT_DIR, `worker-${framework}.js`)
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "cjs",
    minify: true,
    // Model a production Worker bundle: wrangler/vite/esbuild inject this so dev-only branches DCE.
    define: { "process.env.NODE_ENV": '"production"' },
    // Resolve the edge/Worker export condition (`workerd`), falling back to browser/worker, exactly
    // as wrangler does - so each package ships the code path it means for the edge.
    conditions: ["workerd", "worker", "browser"],
  })
  if (!built.success) {
    throw new Error(`${framework} bundle failed:\n${built.logs.map(String).join("\n")}`)
  }
  let src = ""
  for (const o of built.outputs) src += await o.text()
  writeFileSync(outfile, src)
  return gzipSync(Buffer.from(src)).length
}

async function coldSample(framework: Framework): Promise<ColdSample> {
  const bundlePath = join(OUT_DIR, `worker-${framework}.js`)
  const proc = Bun.spawn(["node", join(here, "_measure.mjs"), bundlePath, "cold"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${framework} cold sample exited ${code}:\n${err}`)
  const line = out.trim().split("\n").at(-1) ?? ""
  return parseCold(line)
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`
const ms = (n: number): string => n.toFixed(2)
const pad = (s: string, n: number): string => s.padEnd(n)

async function main(): Promise<void> {
  console.log(`\nBundling ${FRAMEWORKS.length} workers (browser target, workerd condition)...`)
  const gz: Record<string, number> = {}
  for (const f of FRAMEWORKS) gz[f] = await bundle(f)

  const cold: Record<string, ColdSample[]> = Object.fromEntries(FRAMEWORKS.map((f) => [f, []]))
  for (let i = 0; i < COLD_RUNS; i++) {
    for (const f of FRAMEWORKS) cold[f]?.push(await coldSample(f))
  }

  const medianOf = (f: Framework, key: keyof ColdSample): number =>
    median((cold[f] ?? []).map((s) => s[key]))
  const rawCold = medianOf("raw", "coldMs")

  console.log(
    `\n### Workers cold start   (median of ${COLD_RUNS} fresh V8 processes, this box - NOT Cloudflare)\n`,
  )
  console.log(
    `  ${pad("worker", 16)}${pad("bundle gz", 12)}${pad("compile ms", 12)}${pad("init ms", 10)}${pad("1st req ms", 12)}${pad("cold ms", 10)}vs raw`,
  )
  console.log("  " + "-".repeat(81))
  for (const f of FRAMEWORKS) {
    const c = medianOf(f, "coldMs")
    const delta = f === "raw" ? "+0.00 ms" : `+${(c - rawCold).toFixed(2)} ms`
    console.log(
      `  ${pad(f, 16)}${pad(kb(gz[f] ?? 0), 12)}${pad(ms(medianOf(f, "compileMs")), 12)}${pad(ms(medianOf(f, "initMs")), 10)}${pad(ms(medianOf(f, "firstFetchMs")), 12)}${pad(ms(c), 10)}${delta}`,
    )
  }
  console.log(
    "\nWorkers has no Node bootstrap, so compile+init (bundle-size driven) lands closer to cold latency",
  )
  console.log("than on Lambda. Proxy, not workerd - read the delta between rows. See _measure.mjs.")
}

await main()

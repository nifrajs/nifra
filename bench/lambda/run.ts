/**
 * AWS Lambda adapter benchmark - `@nifrajs/aws-lambda` vs `hono/aws-lambda` vs a hand-written
 * payload-v2 handler. Two numbers, because Lambda bills them separately:
 *
 *   COLD - the INIT phase: process start → handler ready → first invocation answered. Measured in
 *          a FRESH PROCESS per sample (a warm process cannot re-measure its own boot), median of
 *          N. This is the number that decides p99 for a spiky function.
 *   WARM - steady-state invocation cost once the container is hot and the JIT has tiered up.
 *          Median of 2,000 in-process invocations.
 *
 * Every row is BUNDLED with `Bun.build({ target: "node" })` first - both because real Node cannot
 * resolve the `@nifrajs/*` workspace packages, and because a single-file bundle is how a Lambda
 * function is actually shipped. Bundling all three rows identically keeps the parse cost fair.
 *
 * This measures the ADAPTER on this box, not AWS. It excludes everything AWS adds to a real cold
 * start - VPC attach, snapshot restore, the runtime's own bootstrap, network setup - so treat the
 * absolute cold numbers as a lower bound and read the DELTA between rows.
 *
 *   bun run bench/lambda/run.ts
 *   BENCH_COLD_RUNS=9 bun run bench/lambda/run.ts
 */

const envInt = (name: string, dflt: number, min = 1): number => {
  const n = Bun.env[name] === undefined ? Number.NaN : Number(Bun.env[name])
  return Number.isInteger(n) && n >= min ? n : dflt
}
const COLD_RUNS = envInt("BENCH_COLD_RUNS", 7)

const FRAMEWORKS = ["nifra", "hono", "raw"] as const
type Framework = (typeof FRAMEWORKS)[number]

const OUT_DIR = `${import.meta.dir}/dist`

interface ColdSample {
  readonly initMs: number
  readonly buildMs: number
  readonly firstInvokeMs: number
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

/** Parse a child's one-line JSON at the trust boundary - it is subprocess output, so validate the
 *  shape instead of trusting property access. */
function parseCold(raw: string): ColdSample {
  const json: unknown = JSON.parse(raw)
  const initMs = finiteNumber(field(json, "initMs"))
  const buildMs = finiteNumber(field(json, "buildMs"))
  const firstInvokeMs = finiteNumber(field(json, "firstInvokeMs"))
  const coldMs = finiteNumber(field(json, "coldMs"))
  if (
    initMs === undefined ||
    buildMs === undefined ||
    firstInvokeMs === undefined ||
    coldMs === undefined
  ) {
    throw new Error(`unexpected cold JSON: ${raw.slice(0, 200)}`)
  }
  return { initMs, buildMs, firstInvokeMs, coldMs }
}

function parseWarm(raw: string): Record<string, number> {
  const json: unknown = JSON.parse(raw)
  const medians = field(json, "warmMedianMs")
  const out: Record<string, number> = {}
  for (const key of ["GET /users/:id", "POST /users"]) {
    const value = finiteNumber(field(medians, key))
    if (value === undefined) throw new Error(`unexpected warm JSON: ${raw.slice(0, 200)}`)
    out[key] = value
  }
  return out
}

async function runBundle(framework: Framework, mode: "cold" | "warm"): Promise<string> {
  const proc = Bun.spawn(["node", `${OUT_DIR}/handler-${framework}.js`, mode], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${framework} ${mode} exited ${code}: ${err.slice(0, 400)}`)
  const line = out.trim().split("\n").at(-1)
  if (line === undefined || line === "") throw new Error(`${framework} ${mode} printed nothing`)
  return line
}

const median = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}

console.log(`\nbundling ${FRAMEWORKS.length} handlers for node...`)
for (const framework of FRAMEWORKS) {
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/handler-${framework}.ts`],
    target: "node",
    outdir: OUT_DIR,
  })
  if (!result.success) {
    throw new Error(`${framework} bundle failed: ${result.logs.map(String).join("; ")}`)
  }
}

const bundleBytes: Record<string, number> = {}
for (const framework of FRAMEWORKS) {
  bundleBytes[framework] = (
    await Bun.file(`${OUT_DIR}/handler-${framework}.js`).arrayBuffer()
  ).byteLength
}

const cold: Record<string, ColdSample> = {}
const warm: Record<string, Record<string, number>> = {}

for (const framework of FRAMEWORKS) {
  const samples: ColdSample[] = []
  for (let i = 0; i < COLD_RUNS; i++) samples.push(parseCold(await runBundle(framework, "cold")))
  cold[framework] = {
    initMs: median(samples.map((s) => s.initMs)),
    buildMs: median(samples.map((s) => s.buildMs)),
    firstInvokeMs: median(samples.map((s) => s.firstInvokeMs)),
    coldMs: median(samples.map((s) => s.coldMs)),
  }
  warm[framework] = parseWarm(await runBundle(framework, "warm"))
}

const pad = (s: string, n: number): string => s.padEnd(n)
const ms = (n: number): string => n.toFixed(2)
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`

console.log(`\n### Cold start   (median of ${COLD_RUNS} fresh processes, this box - NOT AWS)\n`)
console.log(
  `${pad("adapter", 10)}${pad("bundle", 11)}${pad("init ms", 10)}${pad("build ms", 10)}${pad("1st inv ms", 12)}${pad("cold ms", 10)}vs raw`,
)
console.log("-".repeat(70))
const coldFloor = cold.raw?.coldMs ?? 0
for (const framework of FRAMEWORKS) {
  const c = cold[framework]
  if (c === undefined) continue
  const delta = coldFloor > 0 ? `+${ms(c.coldMs - coldFloor)} ms` : "-"
  console.log(
    `${pad(framework, 10)}${pad(kb(bundleBytes[framework] ?? 0), 11)}${pad(ms(c.initMs), 10)}${pad(ms(c.buildMs), 10)}${pad(ms(c.firstInvokeMs), 12)}${pad(ms(c.coldMs), 10)}${delta}`,
  )
}

console.log(`\n### Warm invocation   (median of 2,000 in-process invocations)\n`)
console.log(`${pad("adapter", 10)}${pad("GET us/inv", 14)}${pad("POST us/inv", 14)}GET vs raw`)
console.log("-".repeat(58))
const warmFloor = warm.raw?.["GET /users/:id"] ?? 0
for (const framework of FRAMEWORKS) {
  const w = warm[framework]
  if (w === undefined) continue
  const get = w["GET /users/:id"] ?? 0
  const post = w["POST /users"] ?? 0
  const ratio = warmFloor > 0 ? `${(get / warmFloor).toFixed(1)}x` : "-"
  console.log(
    `${pad(framework, 10)}${pad((get * 1000).toFixed(1), 14)}${pad((post * 1000).toFixed(1), 14)}${ratio}`,
  )
}
console.log("")

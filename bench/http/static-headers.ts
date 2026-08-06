/**
 * A/B for the static response-header tier: `securityHeaders()` DECLARED (no response hook, so the
 * fused native / direct-writer lanes stay open) vs the same five headers written by an
 * `onResponseHeaders` hook, which is what that middleware used to be.
 *
 * Method - the only way a few percent means anything on a shared box:
 *   - fresh subprocess per measurement, INTERLEAVED (static, hook, static, hook, ...) so a thermal
 *     drift or a background spike hits both arms, not one,
 *   - oha -c 50 -z 3s, N rounds, per-arm MEDIAN of rounds,
 *   - every run gated on a 100% success rate; anything less aborts instead of reporting,
 *   - a wire check before measuring: both arms must ship byte-identical headers, or the comparison
 *     is meaningless.
 *
 * Read it as a bound, not a measurement, under ~2%: see bench/linux-rig/ for kernel-honest Node
 * numbers - darwin loopback compresses deltas and thermally drifts mid-batch.
 *
 *   bun run bench/http/static-headers.ts              # every runtime this box has
 *   bun run bench/http/static-headers.ts bun          # one section (bun | node | deno)
 *   BENCH_ROUNDS=5 BENCH_DURATION_S=5 bun run bench/http/static-headers.ts
 */

const envInt = (name: string, dflt: number, min = 1): number => {
  const n = Bun.env[name] === undefined ? Number.NaN : Number(Bun.env[name])
  return Number.isInteger(n) && n >= min ? n : dflt
}
const CONNECTIONS = envInt("BENCH_CONNS", 50)
const DURATION_S = envInt("BENCH_DURATION_S", 3)
const WARMUP_S = envInt("BENCH_WARMUP_S", 2, 0)
const ROUNDS = envInt("BENCH_ROUNDS", 3)
const BASE_PORT = 3600

const VARIANTS = ["static", "hook"] as const
type Variant = (typeof VARIANTS)[number]

const WORKLOADS = [
  { name: "GET /", path: "/" },
  { name: "GET /users/:id", path: "/users/123" },
] as const

const NODE_BUNDLE = `${import.meta.dir}/dist/serve-node-static-headers.js`

interface Section {
  readonly runtime: string
  readonly spawn: (variant: Variant, port: number) => readonly string[]
  readonly prepare?: () => Promise<void>
}

const SECTIONS: readonly Section[] = [
  {
    runtime: "bun",
    spawn: (variant, port) => ["bun", "bench/http/serve-static-headers.ts", variant, String(port)],
  },
  {
    runtime: "node",
    // Real Node cannot resolve the workspace packages (no tsconfig paths), so bundle first - the
    // same treatment the main matrix gives its nifra-on-Node row.
    prepare: async () => {
      const result = await Bun.build({
        entrypoints: [`${import.meta.dir}/serve-node-static-headers.ts`],
        target: "node",
        outdir: `${import.meta.dir}/dist`,
      })
      if (!result.success) {
        throw new Error(`node bundle failed: ${result.logs.map(String).join("; ")}`)
      }
    },
    spawn: (variant, port) => ["node", NODE_BUNDLE, variant, String(port)],
  },
  {
    runtime: "deno",
    spawn: (variant, port) => [
      "deno",
      "run",
      "--allow-net",
      "--allow-env",
      "--no-check",
      "bench/http/serve-deno-static-headers.ts",
      variant,
      String(port),
    ],
  },
]

interface Measure {
  readonly rps: number
  readonly p50ms: number
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined
}

/** Parse oha's JSON at the trust boundary, and refuse anything that was not a clean 100% run. */
function parseOha(raw: string): Measure {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`oha: output was not JSON: ${raw.slice(0, 160)}`)
  }
  const summary = field(json, "summary")
  const rps = finiteNumber(field(summary, "requestsPerSec"))
  const successRate = finiteNumber(field(summary, "successRate"))
  const p50 = finiteNumber(field(field(json, "latencyPercentiles"), "p50"))
  if (rps === undefined || p50 === undefined) {
    throw new Error(`oha: unexpected JSON shape: ${raw.slice(0, 200)}`)
  }
  if (successRate !== 1) {
    throw new Error(`oha: success rate ${String(successRate)} - refusing to report a lossy run`)
  }
  return { rps: Math.round(rps), p50ms: p50 * 1000 }
}

async function runOha(url: string, durationS: number): Promise<Measure> {
  const proc = Bun.spawn(
    [
      "oha",
      "-c",
      String(CONNECTIONS),
      "-z",
      `${durationS}s`,
      "--no-tui",
      "--output-format",
      "json",
      url,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, NO_COLOR: "true" } },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`oha exited ${code}: ${err.slice(0, 200)}`)
  return parseOha(out)
}

async function waitReady(base: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      const res = await fetch(base)
      if (res.ok) {
        await res.text()
        return
      }
    } catch {
      // booting - retry
    }
    await Bun.sleep(50)
  }
  throw new Error(`server at ${base} did not become ready within ${timeoutMs}ms`)
}

/** The header lines a variant actually ships, for the equal-wire precondition. */
async function wireOf(base: string): Promise<string> {
  const res = await fetch(`${base}/`)
  const headers = [...res.headers]
    .filter(([name]) => name !== "date" && name !== "keep-alive" && name !== "connection")
    .map(([name, value]) => `${name}: ${value}`)
    .sort()
  return `${res.status}\n${headers.join("\n")}\n${await res.text()}`
}

const argv = process.argv.slice(2)
const onlyRuntime = argv.find((a) => !a.startsWith("--"))
const sections = onlyRuntime ? SECTIONS.filter((s) => s.runtime === onlyRuntime) : SECTIONS
if (sections.length === 0) {
  throw new Error(
    `unknown runtime "${onlyRuntime}". known: ${SECTIONS.map((s) => s.runtime).join(", ")}`,
  )
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}

console.log(
  `\nstatic response headers - securityHeaders() declared vs the same headers via a hook` +
    `\noha -c ${CONNECTIONS} -z ${DURATION_S}s, ${ROUNDS} interleaved rounds, per-arm median, fresh process per run\n`,
)

let port = BASE_PORT
for (const section of sections) {
  if (section.prepare) await section.prepare()
  // rounds[workload][variant] = [rps per round]
  const collected = new Map<string, Map<Variant, number[]>>()
  for (const w of WORKLOADS) {
    const byVariant = new Map<Variant, number[]>()
    for (const variant of VARIANTS) byVariant.set(variant, [])
    collected.set(w.name, byVariant)
  }
  const wires = new Map<Variant, string>()

  let failed: string | undefined
  for (let round = 0; round < ROUNDS && failed === undefined; round++) {
    for (const variant of VARIANTS) {
      port += 1
      const base = `http://127.0.0.1:${port}`
      let proc: ReturnType<typeof Bun.spawn> | undefined
      try {
        proc = Bun.spawn([...section.spawn(variant, port)], {
          stdout: "ignore",
          stderr: "inherit",
        })
        await waitReady(base, 8000)
        const wire = await wireOf(base)
        const known = wires.get(variant)
        if (known !== undefined && known !== wire) {
          throw new Error(`${variant}: wire changed between rounds`)
        }
        wires.set(variant, wire)
        for (const w of WORKLOADS) {
          await runOha(`${base}${w.path}`, WARMUP_S)
          const measured = await runOha(`${base}${w.path}`, DURATION_S)
          collected.get(w.name)?.get(variant)?.push(measured.rps)
        }
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e)
      } finally {
        proc?.kill()
        await proc?.exited
      }
    }
  }

  console.log(`  ${section.runtime}`)
  if (failed !== undefined) {
    console.log(`    skipped: ${failed}\n`)
    continue
  }
  const staticWire = wires.get("static")
  if (staticWire !== wires.get("hook")) {
    console.log(
      `    ABORTED: the two variants do not ship the same wire, so the comparison is void\n` +
        `      static: ${JSON.stringify(staticWire)}\n      hook:   ${JSON.stringify(wires.get("hook"))}\n`,
    )
    continue
  }
  for (const w of WORKLOADS) {
    const byVariant = collected.get(w.name)
    const hook = median(byVariant?.get("hook") ?? [])
    const declared = median(byVariant?.get("static") ?? [])
    const delta = hook === 0 ? 0 : ((declared - hook) / hook) * 100
    console.log(
      `    ${w.name.padEnd(16)} hook ${hook.toLocaleString().padStart(8)} req/s` +
        `   declared ${declared.toLocaleString().padStart(8)} req/s` +
        `   ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`,
    )
  }
  console.log()
}

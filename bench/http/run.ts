/**
 * HTTP throughput matrix — nifra vs the field — driven by `oha` (a real Rust load
 * tool), sectioned by runtime. For each framework: spawn its server in an isolated
 * subprocess, wait until ready, warm the JIT, then take N timed oha runs and keep
 * the MEDIAN (robust to box noise; best is reported too). Servers run ONE AT A TIME
 * — no cross-contention. Identical routes + payloads across every framework.
 *
 * READ THE RATIOS, NOT THE ABSOLUTES. This shares one (likely virtualized) box with
 * the load client, so absolute req/s is noisy and not publication-grade — but every
 * framework pays that tax equally in the SAME run, so the same-run ratio (nifra vs
 * Elysia vs the runtime ceiling) is the trustworthy signal. See BENCHMARKS.md.
 *
 *   bun run bench/http/run.ts            # every section this build knows
 *   bun run bench/http/run.ts bun        # one section only (bun | node | deno)
 */

const CONNECTIONS = 50
const DURATION_S = 4
const WARMUP_S = 2
const RUNS = 3
const BASE_PORT = 3400

interface Workload {
  readonly name: string
  readonly path: string
  readonly post?: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
}

const GET_ROOT: Workload = { name: "GET /", path: "/" }
const GET_USER: Workload = { name: "GET /users/:id", path: "/users/123" }
const GET_SEARCH: Workload = { name: "GET /search?query", path: "/search?q=ada&limit=10" }
const POST_USERS: Workload = {
  name: "POST /users",
  path: "/users",
  post: {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", age: 36 }),
  },
}

// Default is the meaningful pair — one read (routing + path param) + one write (body validation) —
// which roughly halves the suite. `--full` adds the GET / baseline and the GET /search query-
// validation workloads for the detailed BENCHMARKS.md tables.
const WORKLOADS: readonly Workload[] = process.argv.includes("--full")
  ? [GET_ROOT, GET_USER, GET_SEARCH, POST_USERS]
  : [GET_USER, POST_USERS]

interface Target {
  readonly framework: string
  /** The argv that boots this framework's server on `port`. */
  readonly spawn: (port: number) => readonly string[]
  /** One-time setup before this target's first spawn (e.g. build a bundle). */
  readonly prepare?: () => Promise<void>
  /** The framework treated as the section's ceiling (for the "% of ceiling" column). */
  readonly isCeiling?: boolean
}

interface Section {
  readonly runtime: string
  readonly targets: readonly Target[]
}

const bunTarget = (framework: string): Target => ({
  framework,
  spawn: (port) => ["bun", "bench/http/serve.ts", framework, String(port)],
})

const nodeTarget = (framework: string): Target => ({
  framework,
  // Node 24 strips TS types natively — no build step (the spike confirmed it).
  spawn: (port) => ["node", "bench/http/serve-node.ts", framework, String(port)],
})

const denoTarget = (framework: string): Target => ({
  framework,
  // Deno runs the local TS source directly. `--no-check` keeps startup out of the runtime comparison.
  // `--allow-env`: Elysia reads process.env.NODE_ENV at import (Node/Bun grant env by default; Deno doesn't).
  spawn: (port) => [
    "deno",
    "run",
    "--allow-net",
    "--allow-env",
    "--no-check",
    "bench/http/serve-deno.ts",
    framework,
    String(port),
  ],
})

// nifra on Node: real Node can't resolve the @nifrajs/* workspace packages (Bun resolves
// them via tsconfig paths, which Node ignores), so bundle the app for Node first — which
// is also nifra's actual Node deploy path. The bundle lands in a gitignored dist/ dir.
const NIFRA_NODE_BUNDLE = `${import.meta.dir}/dist/serve-node-nifra.js`
const nifraNodeTarget: Target = {
  framework: "nifra",
  prepare: async () => {
    const result = await Bun.build({
      entrypoints: [`${import.meta.dir}/serve-node-nifra.ts`],
      target: "node",
      outdir: `${import.meta.dir}/dist`,
    })
    if (!result.success) {
      throw new Error(`nifra-node bundle failed: ${result.logs.map(String).join("; ")}`)
    }
  },
  spawn: (port) => ["node", NIFRA_NODE_BUNDLE, String(port)],
}

const SECTIONS: readonly Section[] = [
  {
    runtime: "bun",
    targets: [
      bunTarget("nifra"),
      bunTarget("elysia"),
      bunTarget("hono"),
      bunTarget("bun-raw"),
      { ...bunTarget("bun-native"), isCeiling: true },
    ],
  },
  {
    runtime: "node",
    targets: [
      nifraNodeTarget,
      nodeTarget("hono"),
      nodeTarget("fastify"),
      nodeTarget("express"),
      nodeTarget("elysia"),
      { ...nodeTarget("node-raw"), isCeiling: true },
    ],
  },
  {
    runtime: "deno",
    targets: [
      denoTarget("nifra"),
      denoTarget("hono"),
      denoTarget("elysia"),
      { ...denoTarget("deno-raw"), isCeiling: true },
    ],
  },
]

interface Measure {
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
}

const ZERO: Measure = { rps: 0, p50ms: 0, p99ms: 0 }

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined
}

/**
 * Parse oha's `--output-format json` at the trust boundary — it's external tool
 * output, so validate the shape rather than trusting property access. oha reports
 * latencies in SECONDS; we convert to ms here.
 */
function parseOha(raw: string): Measure {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`oha: output was not JSON: ${raw.slice(0, 160)}`)
  }
  const rps = finiteNumber(field(field(json, "summary"), "requestsPerSec"))
  const lat = field(json, "latencyPercentiles")
  const p50 = finiteNumber(field(lat, "p50"))
  const p99 = finiteNumber(field(lat, "p99"))
  if (rps === undefined || p50 === undefined || p99 === undefined) {
    throw new Error(`oha: unexpected JSON shape: ${raw.slice(0, 200)}`)
  }
  return { rps: Math.round(rps), p50ms: p50 * 1000, p99ms: p99 * 1000 }
}

async function runOha(url: string, w: Workload, durationS: number): Promise<Measure> {
  const args = [
    "-c",
    String(CONNECTIONS),
    "-z",
    `${durationS}s`,
    "--no-tui",
    "--output-format",
    "json",
  ] // prettier-ignore
  if (w.post) {
    args.push("-m", "POST", "-d", w.post.body)
    for (const [k, v] of Object.entries(w.post.headers)) args.push("-H", `${k}: ${v}`)
  }
  args.push(url)
  // Some shells export NO_COLOR=1; oha 1.14 expects a boolean-ish value, so normalize it for the child.
  const proc = Bun.spawn(["oha", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, NO_COLOR: "true" },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`oha exited ${code}: ${err.slice(0, 200)}`)
  return parseOha(out)
}

/** Median req/s across N runs (best reported too). The median resists outliers; a
 *  single slow run from a background CPU spike can't drag the reported number down. */
async function sample(url: string, w: Workload): Promise<{ median: Measure; best: Measure }> {
  const runs: Measure[] = []
  for (let i = 0; i < RUNS; i++) runs.push(await runOha(url, w, DURATION_S))
  const sorted = [...runs].sort((a, b) => a.rps - b.rps)
  const median = sorted[sorted.length >> 1] ?? ZERO
  const best = sorted[sorted.length - 1] ?? ZERO
  return { median, best }
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
      // booting — retry
    }
    await Bun.sleep(50)
  }
  throw new Error(`server at ${base} did not become ready within ${timeoutMs}ms`)
}

// results[runtime][framework][workload] = median Measure
type Results = Record<string, Record<string, Record<string, Measure>>>
const results: Results = {}

const argv = process.argv.slice(2)
// `--json` emits one machine-readable line (consumed by aggregate.ts to median across runs); the
// optional positional filters to one runtime section (`bun` | `node`).
const jsonMode = argv.includes("--json")
const onlyRuntime = argv.find((a) => !a.startsWith("--"))
const sections = onlyRuntime ? SECTIONS.filter((s) => s.runtime === onlyRuntime) : SECTIONS
if (sections.length === 0) {
  throw new Error(
    `unknown runtime "${onlyRuntime}". known: ${SECTIONS.map((s) => s.runtime).join(", ")}`,
  )
}

for (const section of sections) {
  const sectionResults: Record<string, Record<string, Measure>> = {}
  results[section.runtime] = sectionResults
  let port = BASE_PORT
  for (const target of section.targets) {
    port += 1
    // Pin IPv4 loopback. `localhost` can resolve to ::1 first; Deno's default listener is IPv4-only on
    // this box, which made oha report connection-refused errors even though a browser/curl fallback
    // succeeded. A benchmark should not include DNS/address-family variance.
    const base = `http://127.0.0.1:${port}`
    const fwResults: Record<string, Measure> = {}
    sectionResults[target.framework] = fwResults
    let proc: ReturnType<typeof Bun.spawn> | undefined
    try {
      if (target.prepare) await target.prepare()
      proc = Bun.spawn([...target.spawn(port)], { stdout: "ignore", stderr: "inherit" })
      await waitReady(base, 8000)
      for (const w of WORKLOADS) {
        await runOha(`${base}${w.path}`, w, WARMUP_S) // warm the JIT for this workload
        const { median } = await sample(`${base}${w.path}`, w)
        fwResults[w.name] = median
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`  ${section.runtime}/${target.framework}: ${msg}`)
    } finally {
      proc?.kill()
      await proc?.exited
      await Bun.sleep(1500) // allow CPU to cool down and ports to clear
    }
  }
}

function pad(s: string, n: number): string {
  return s.padStart(n)
}

function toolVersion(cmd: string, arg: string): string {
  try {
    const r = Bun.spawnSync([cmd, arg])
    if (!r.success) return "unknown"
    const first = new TextDecoder().decode(r.stdout).trim().split(/\r?\n/)[0]?.trim()
    if (first === undefined || first === "") return "unknown"
    // `oha --version` => "oha 1.14.0"; `deno --version` => "deno 2.8.1"; `node --version` => "v26.0.0".
    if (cmd === "oha" || cmd === "deno") return first.split(/\s+/)[1] ?? first
    return first
  } catch {
    return "unavailable"
  }
}

const meta = {
  bun: Bun.version,
  node: toolVersion("node", "--version"),
  deno: toolVersion("deno", "--version"),
  oha: toolVersion("oha", "--version"),
  runs: RUNS,
  durationS: DURATION_S,
  connections: CONNECTIONS,
}

// `--json`: one line of machine-readable results for aggregate.ts. No device/host/path info — only
// tool versions + the run knobs + the measured numbers.
if (jsonMode) {
  console.log(JSON.stringify({ meta, results }))
  process.exit(0)
}

const versions = `Bun ${meta.bun} · Node ${meta.node} · Deno ${meta.deno}`
console.log(
  `\nHTTP throughput — oha, median-of-${RUNS} × ${DURATION_S}s @ ${CONNECTIONS} conns  (${versions})\nRatios on the same run are the signal; absolutes are indicative only.\n`,
)

for (const section of sections) {
  const got = results[section.runtime] ?? {}
  const ceiling = section.targets.find((t) => t.isCeiling)?.framework
  console.log(`## ${section.runtime}\n`)
  for (const w of WORKLOADS) {
    console.log(`  ${w.name}`)
    const rows = section.targets.map((t) => ({
      f: t.framework,
      m: got[t.framework]?.[w.name] ?? ZERO,
    }))
    const top = Math.max(1, ...rows.map((r) => r.m.rps))
    const ceil = ceiling ? (got[ceiling]?.[w.name]?.rps ?? 0) : 0
    for (const { f, m } of rows) {
      const ofTop = Math.round((m.rps / top) * 100)
      const ofCeil =
        ceil > 0 ? `${pad(String(Math.round((m.rps / ceil) * 100)), 3)}% of ceiling` : ""
      console.log(
        `    ${f.padEnd(9)} ${pad(m.rps.toLocaleString(), 9)} req/s   ` +
          `p50 ${pad(m.p50ms.toFixed(2), 6)}ms   p99 ${pad(m.p99ms.toFixed(2), 7)}ms   ` +
          `${pad(String(ofTop), 3)}% of top   ${ofCeil}`,
      )
    }
    const nifra = got.nifra?.[w.name]?.rps ?? 0
    const elysia = got.elysia?.[w.name]?.rps ?? 0
    if (nifra > 0 && elysia > 0) {
      console.log(`    → nifra is ${Math.round((nifra / elysia) * 100)}% of Elysia`)
    }
    console.log("")
  }
}

export {}

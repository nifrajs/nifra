/**
 * REALISTIC-shape HTTP throughput matrix - the auth+middleware companion to bench/http/run.ts, same
 * harness shape (oha, isolated subprocess per framework, one runtime section at a time, median-of-N).
 *
 * bench/http/ measures the framework floor: bare GET, one path param, one validated query, one
 * validated body - the shape nifra's fused Web lane targets, and the shape most benchmarks (including
 * TechEmpower) use. This suite measures the same GET/POST split but on a route that has what a real
 * API route actually has: security headers, CORS, a request-id hook, bearer-token auth via a derive,
 * and a cookie read - on nifra specifically, that combination disqualifies the route from every fused
 * lane (bare/query/body), so it always runs the general lifecycle path. Run both suites and compare
 * the SAME framework's ratio across them to see the fused-lane premium directly, rather than taking
 * the bare-route number as if it generalizes.
 *
 * A third workload adds ONE body-observing middleware to the same GET (the `*-body` targets), each
 * framework through its own idiomatic body tier - the cost a header-only comparison can't show.
 *
 *   bun run bench/http-realworld/run.ts            # every section this build knows
 *   bun run bench/http-realworld/run.ts bun        # one section only (bun | node | deno)
 */
const envInt = (name: string, dflt: number, min = 1): number => {
  const n = Bun.env[name] === undefined ? Number.NaN : Number(Bun.env[name])
  return Number.isInteger(n) && n >= min ? n : dflt
}
const CONNECTIONS = envInt("BENCH_CONNS", 50)
const DURATION_S = envInt("BENCH_DURATION_S", 4)
const WARMUP_S = envInt("BENCH_WARMUP_S", 2, 0)
const RUNS = envInt("BENCH_RUNS", 3)
const BASE_PORT = 3600

const AUTH_HEADERS: Readonly<Record<string, string>> = {
  authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
  cookie: "theme=dark",
  // Real CORS middleware (nifra's included) gates Access-Control-Allow-* on the request actually
  // carrying an Origin header - that's spec-correct, not nifra-specific. Every hand-rolled competitor
  // target in this suite emits those headers unconditionally, so omitting Origin here would make
  // nifra do LESS header work than everyone else and understate its own cost. Match what a real
  // cross-origin browser request sends (the same origin every target's CORS allowlist expects).
  origin: "https://app.example.com",
}

interface Workload {
  readonly name: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly post?: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
}

const GET_ORDERS: Workload = {
  name: "GET /api/orders (auth + 3 middleware)",
  path: "/api/orders?limit=10",
  headers: AUTH_HEADERS,
}
const POST_ORDERS: Workload = {
  name: "POST /api/orders (auth + 3 middleware)",
  path: "/api/orders",
  headers: AUTH_HEADERS,
  post: {
    // auth/cookie already come from `headers` above - only content-type is POST-specific.
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "SKU-1", qty: 2, note: "gift wrap" }),
  },
}
// Same GET, but served by the `*-body` targets: the realistic route PLUS one body-observing
// middleware (an x-body-hash header over the final serialized body), each framework through its own
// idiomatic mechanism - nifra's onResponseBody payload tier, Fastify's onSend, Elysia's mapResponse,
// Hono's drain-and-rebuild, Express's res.json wrap, inline for the raw ceilings. This is the
// workload header-only comparisons can't show: what a framework charges middleware to SEE the body.
const GET_ORDERS_BODY: Workload = {
  name: "GET /api/orders (auth + middleware + body-hash)",
  path: "/api/orders?limit=10",
  headers: AUTH_HEADERS,
}

const WORKLOADS: readonly Workload[] = [GET_ORDERS, POST_ORDERS]
const BODY_WORKLOADS: readonly Workload[] = [GET_ORDERS_BODY]
const ALL_WORKLOADS: readonly Workload[] = [...WORKLOADS, ...BODY_WORKLOADS]

interface Target {
  readonly framework: string
  readonly spawn: (port: number) => readonly string[]
  readonly prepare?: () => Promise<void>
  readonly isCeiling?: boolean
  /** Workloads this target serves; defaults to the plain GET/POST pair. */
  readonly workloads?: readonly Workload[]
}

interface Section {
  readonly runtime: string
  readonly targets: readonly Target[]
}

const bunTarget = (framework: string): Target => ({
  framework,
  spawn: (port) => ["bun", "bench/http-realworld/serve.ts", framework, String(port)],
})

const nodeTarget = (framework: string): Target => ({
  framework,
  spawn: (port) => ["node", "bench/http-realworld/serve-node.ts", framework, String(port)],
})

const denoTarget = (framework: string): Target => ({
  framework,
  spawn: (port) => [
    "deno",
    "run",
    "--allow-net",
    "--allow-env",
    "--no-check",
    "bench/http-realworld/serve-deno.ts",
    framework,
    String(port),
  ],
})

const NIFRA_NODE_BUNDLE = `${import.meta.dir}/dist/serve-node-nifra.js`
const buildNifraNodeBundle = async (): Promise<void> => {
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/serve-node-nifra.ts`],
    target: "node",
    outdir: `${import.meta.dir}/dist`,
  })
  if (!result.success) {
    throw new Error(`nifra-node bundle failed: ${result.logs.map(String).join("; ")}`)
  }
}
const nifraNodeTarget: Target = {
  framework: "nifra",
  prepare: buildNifraNodeBundle,
  spawn: (port) => ["node", NIFRA_NODE_BUNDLE, String(port)],
}
const nifraNodeBodyTarget: Target = {
  framework: "nifra-body",
  prepare: buildNifraNodeBundle,
  spawn: (port) => ["node", NIFRA_NODE_BUNDLE, String(port), "body"],
  workloads: BODY_WORKLOADS,
}

const bodyTarget = (t: Target): Target => ({ ...t, workloads: BODY_WORKLOADS })

const SECTIONS: readonly Section[] = [
  {
    runtime: "bun",
    targets: [
      bunTarget("nifra"),
      bunTarget("elysia"),
      bunTarget("hono"),
      { ...bunTarget("bun-native"), isCeiling: true },
      bodyTarget(bunTarget("nifra-body")),
      bodyTarget(bunTarget("elysia-body")),
      bodyTarget(bunTarget("hono-body")),
      { ...bodyTarget(bunTarget("bun-native-body")), isCeiling: true },
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
      nifraNodeBodyTarget,
      bodyTarget(nodeTarget("hono-body")),
      bodyTarget(nodeTarget("fastify-body")),
      bodyTarget(nodeTarget("express-body")),
      bodyTarget(nodeTarget("elysia-body")),
      { ...bodyTarget(nodeTarget("node-raw-body")), isCeiling: true },
    ],
  },
  {
    runtime: "deno",
    targets: [
      denoTarget("nifra"),
      denoTarget("hono"),
      denoTarget("elysia"),
      { ...denoTarget("deno-raw"), isCeiling: true },
      bodyTarget(denoTarget("nifra-body")),
      bodyTarget(denoTarget("hono-body")),
      bodyTarget(denoTarget("elysia-body")),
      { ...bodyTarget(denoTarget("deno-raw-body")), isCeiling: true },
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
  for (const [k, v] of Object.entries(w.headers)) args.push("-H", `${k}: ${v}`)
  if (w.post) {
    args.push("-m", "POST", "-d", w.post.body)
    for (const [k, v] of Object.entries(w.post.headers)) args.push("-H", `${k}: ${v}`)
  }
  args.push(url)
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
      const res = await fetch(`${base}${GET_ORDERS.path}`, { headers: AUTH_HEADERS })
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

type Results = Record<string, Record<string, Record<string, Measure>>>
const results: Results = {}

const argv = process.argv.slice(2)
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
    const base = `http://127.0.0.1:${port}`
    const fwResults: Record<string, Measure> = {}
    sectionResults[target.framework] = fwResults
    let proc: ReturnType<typeof Bun.spawn> | undefined
    try {
      if (target.prepare) await target.prepare()
      proc = Bun.spawn([...target.spawn(port)], { stdout: "ignore", stderr: "inherit" })
      await waitReady(base, 8000)
      for (const w of target.workloads ?? WORKLOADS) {
        // oha with `-z 0s` exits before collecting percentiles - a zero warmup means "no warmup".
        if (WARMUP_S > 0) await runOha(`${base}${w.path}`, w, WARMUP_S)
        const { median } = await sample(`${base}${w.path}`, w)
        fwResults[w.name] = median
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`  ${section.runtime}/${target.framework}: ${msg}`)
    } finally {
      proc?.kill()
      await proc?.exited
      await Bun.sleep(1500)
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

if (jsonMode) {
  console.log(JSON.stringify({ meta, results }))
  process.exit(0)
}

const versions = `Bun ${meta.bun} · Node ${meta.node} · Deno ${meta.deno}`
console.log(
  `\nRealistic-shape HTTP throughput (auth + security headers + CORS + request-id + cookie) - oha, median-of-${RUNS} × ${DURATION_S}s @ ${CONNECTIONS} conns  (${versions})\nRatios on the same run are the signal; absolutes are indicative only.\n`,
)

for (const section of sections) {
  const got = results[section.runtime] ?? {}
  console.log(`## ${section.runtime}\n`)
  for (const w of ALL_WORKLOADS) {
    // Each workload is served by the targets that declare it (plain rows vs the *-body rows), and
    // each group carries its own raw ceiling.
    const group = section.targets.filter((t) => (t.workloads ?? WORKLOADS).includes(w))
    if (group.length === 0) continue
    console.log(`  ${w.name}`)
    const ceiling = group.find((t) => t.isCeiling)?.framework
    const rows = group.map((t) => ({
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
        `    ${f.padEnd(15)} ${pad(m.rps.toLocaleString(), 9)} req/s   ` +
          `p50 ${pad(m.p50ms.toFixed(2), 6)}ms   p99 ${pad(m.p99ms.toFixed(2), 7)}ms   ` +
          `${pad(String(ofTop), 3)}% of top   ${ofCeil}`,
      )
    }
    const nifra = rows.find((r) => r.f.startsWith("nifra"))?.m.rps ?? 0
    const elysia = rows.find((r) => r.f.startsWith("elysia"))?.m.rps ?? 0
    if (nifra > 0 && elysia > 0) {
      console.log(`    → nifra is ${Math.round((nifra / elysia) * 100)}% of Elysia`)
    }
    console.log("")
  }
}

export {}

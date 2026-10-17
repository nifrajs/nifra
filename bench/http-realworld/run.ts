/**
 * REALISTIC-shape HTTP throughput matrix - the auth+middleware companion to bench/http/run.ts, same
 * harness shape (oha, one subprocess per framework, one runtime section at a time, every server of a
 * section up at once and sampled in interleaved rounds; % of ceiling is the median of per-round
 * ratios to the raw row serving the same workload).
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
 *
 * `BENCH_APP_DIR` points the server files at a different directory. It exists so the same harness can
 * measure the PUBLISHED packages instead of this checkout: `bench:published:setup` installs a pinned
 * `@nifrajs/*` from npm into an isolated tree and writes servers that resolve there, and this runs
 * them unchanged. The default is this directory, which imports the workspace `dist/` - already the
 * built artifact rather than `src/` (see _nifra-app.ts), so the published mode closes the narrower
 * gap between a local build and the tarball actually shipped.
 */
import { loadavg } from "node:os"
import {
  type Matrix,
  type Measure,
  mergeRuns,
  pooledRatio,
  pushRounds,
  roundOrder,
} from "../rounds.ts"

const APP_DIR = Bun.env.BENCH_APP_DIR ?? "bench/http-realworld"
const envInt = (name: string, dflt: number, min = 1): number => {
  const n = Bun.env[name] === undefined ? Number.NaN : Number(Bun.env[name])
  return Number.isInteger(n) && n >= min ? n : dflt
}
const CONNECTIONS = envInt("BENCH_CONNS", 50)
const REQUESTS_PER_SAMPLE = envInt("BENCH_REQUESTS", 100_000)
const SCALE_PCT = envInt("BENCH_SCALE", 100)
const WARMUP = envInt("BENCH_WARMUP", 1, 0)
/** Rounded up to even: an unpaired round favours one end of its order (bench/rounds.ts). */
const ROUNDS = Math.ceil(envInt("BENCH_ROUNDS", 4) / 2) * 2
/** Shifts the round rotation, so repeated aggregate runs start from different rows. */
const ROUND_OFFSET = envInt("BENCH_ROUND_OFFSET", 0, 0)
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
  spawn: (port) => ["bun", `${APP_DIR}/serve.ts`, framework, String(port)],
})

const nodeTarget = (framework: string): Target => ({
  framework,
  spawn: (port) => ["node", `${APP_DIR}/serve-node.ts`, framework, String(port)],
})

const denoTarget = (framework: string): Target => ({
  framework,
  spawn: (port) => [
    "deno",
    "run",
    "--allow-net",
    "--allow-env",
    "--allow-read",
    "--no-check",
    `${APP_DIR}/serve-deno.ts`,
    framework,
    String(port),
  ],
})

// Built from APP_DIR so the bundle inlines whichever `@nifrajs/*` that directory resolves - the
// workspace by default, the installed tarballs under the published tree. The Node arm is bundled, so
// its source choice is made here at build time rather than by a runtime switch.
const NIFRA_NODE_BUNDLE = `${APP_DIR}/dist/serve-node-nifra.js`
const buildNifraNodeBundle = async (): Promise<void> => {
  const result = await Bun.build({
    entrypoints: [`${APP_DIR}/serve-node-nifra.ts`],
    target: "node",
    outdir: `${APP_DIR}/dist`,
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

const serves = (t: Target, workload: string): boolean =>
  (t.workloads ?? WORKLOADS).some((w) => w.name === workload)

/** Each workload is served by the targets that declare it, and each group carries its own raw row. */
const ceilingOf = (runtime: string, workload: string): string | undefined =>
  SECTIONS.find((s) => s.runtime === runtime)?.targets.find(
    (t) => t.isCeiling === true && serves(t, workload),
  )?.framework

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined
}

function parseOha(raw: string, expectedRequests: number): Measure {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`oha: output was not JSON: ${raw.slice(0, 160)}`)
  }
  const summary = field(json, "summary")
  const rps = finiteNumber(field(summary, "requestsPerSec"))
  const lat = field(json, "latencyPercentiles")
  const p50 = finiteNumber(field(lat, "p50"))
  const p99 = finiteNumber(field(lat, "p99"))
  const successRate = finiteNumber(field(summary, "successRate"))
  const okRequests = finiteNumber(field(field(json, "statusCodeDistribution"), "200"))
  if (
    rps === undefined ||
    p50 === undefined ||
    p99 === undefined ||
    successRate === undefined ||
    okRequests === undefined
  ) {
    throw new Error(`oha: unexpected JSON shape: ${raw.slice(0, 200)}`)
  }
  if (successRate !== 1 || okRequests !== expectedRequests) {
    throw new Error(
      `oha: invalid sample (successRate=${successRate}, HTTP 200=${okRequests}/${expectedRequests})`,
    )
  }
  return { rps: Math.round(rps), p50ms: p50 * 1000, p99ms: p99 * 1000 }
}

async function runOha(url: string, w: Workload, requests: number): Promise<Measure> {
  const args = [
    "-c",
    String(CONNECTIONS),
    "-n",
    String(requests),
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
  return parseOha(out, requests)
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

// sampled[runtime][framework][workload].rounds - one Measure per round, in round order.
const sampled: Matrix<{ rounds: Measure[] }> = {}
const failures: string[] = []

const argv = process.argv.slice(2)
const jsonMode = argv.includes("--json")
const onlyRuntime = argv.find((a) => !a.startsWith("--"))
const sections = onlyRuntime ? SECTIONS.filter((s) => s.runtime === onlyRuntime) : SECTIONS
if (sections.length === 0) {
  throw new Error(
    `unknown runtime "${onlyRuntime}". known: ${SECTIONS.map((s) => s.runtime).join(", ")}`,
  )
}

const pct = (ratio: number): string => String(Math.round(ratio * 100))

interface Server {
  readonly target: Target
  readonly base: string
  readonly proc: ReturnType<typeof Bun.spawn>
}

for (const section of sections) {
  const servers: Server[] = []
  const failed = new Set<Target>()
  const fail = (target: Target, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e)
    failures.push(`${section.runtime}/${target.framework}: ${msg}`)
    console.error(`  ${section.runtime}/${target.framework}: ${msg}`)
    failed.add(target)
  }
  // The plain and `-body` nifra Node targets share one bundle; build it once.
  const prepared = new Map<() => Promise<void>, Promise<void>>()
  try {
    let port = BASE_PORT
    for (const target of section.targets) {
      port += 1
      const base = `http://127.0.0.1:${port}`
      try {
        const { prepare } = target
        if (prepare) {
          if (!prepared.has(prepare)) prepared.set(prepare, prepare())
          await prepared.get(prepare)
        }
        const proc = Bun.spawn([...target.spawn(port)], { stdout: "ignore", stderr: "inherit" })
        servers.push({ target, base, proc })
        await waitReady(base, 8000)
      } catch (e) {
        fail(target, e)
      }
    }
    for (const w of ALL_WORKLOADS) {
      const group = (): Server[] =>
        servers.filter((s) => !failed.has(s.target) && serves(s.target, w.name))
      if (group().length === 0) continue
      const ceiling = ceilingOf(section.runtime, w.name)
      const requests = Math.max(500, Math.round((REQUESTS_PER_SAMPLE * SCALE_PCT) / 100))
      // Count-bounded samples finish in-flight POSTs cleanly; duration cutoffs can leave Deno.serve
      // degraded for later workloads. Warmup uses the same request path at 20% load.
      if (WARMUP > 0) {
        for (const s of group()) {
          try {
            await runOha(`${s.base}${w.path}`, w, Math.max(500, Math.round(requests / 5)))
          } catch (e) {
            fail(s.target, e)
          }
        }
      }
      for (let round = 0; round < ROUNDS; round++) {
        for (const s of roundOrder(group(), round + ROUND_OFFSET)) {
          try {
            const m = await runOha(`${s.base}${w.path}`, w, requests)
            pushRounds(sampled, section.runtime, s.target.framework, w.name, m)
          } catch (e) {
            fail(s.target, e)
          }
        }
        // A failed row stops sampling, so a live row's rounds are indexed by round number.
        const inRound = (f: string | undefined): Measure | undefined =>
          f === undefined ? undefined : sampled[section.runtime]?.[f]?.[w.name]?.rounds[round]
        const ceil = inRound(ceiling)
        const line = group().map(({ target: { framework: f } }) => {
          const m = inRound(f)
          return `${f} ${m?.rps.toLocaleString() ?? "-"}${m && ceil ? ` (${pct(m.rps / ceil.rps)}%)` : ""}`
        })
        console.error(
          `  ${section.runtime} ${w.name}  round ${round + 1}/${ROUNDS}  load ${loadavg()[0]?.toFixed(1)}  ${line.join(" · ")}`,
        )
      }
    }
  } finally {
    for (const s of servers) s.proc.kill()
    await Promise.all(servers.map((s) => s.proc.exited))
    await Bun.sleep(1500)
  }
}
if (failures.length > 0) {
  throw new Error(
    `benchmark results are invalid; ${failures.length} target(s) failed: ${failures.join("; ")}`,
  )
}

const results = mergeRuns([sampled], ceilingOf)

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
  rounds: ROUNDS,
  requestsPerRun: Math.max(500, Math.round((REQUESTS_PER_SAMPLE * SCALE_PCT) / 100)),
  scalePct: SCALE_PCT,
  connections: CONNECTIONS,
}

if (jsonMode) {
  console.log(JSON.stringify({ meta, results }))
  process.exit(0)
}

const versions = `Bun ${meta.bun} · Node ${meta.node} · Deno ${meta.deno}`
console.log(
  `\nRealistic-shape HTTP throughput (auth + security headers + CORS + request-id + cookie) - oha, ${ROUNDS} interleaved rounds of count-bounded samples (${meta.requestsPerRun} requests/workload @ ${CONNECTIONS} conns)  (${versions})\n% of ceiling is the median of per-round ratios to the raw row serving that workload; req/s is the median round, indicative only.\n`,
)

for (const section of sections) {
  const got = results[section.runtime] ?? {}
  console.log(`## ${section.runtime}\n`)
  for (const w of ALL_WORKLOADS) {
    const group = section.targets.filter((t) => serves(t, w.name))
    if (group.length === 0) continue
    console.log(`  ${w.name}`)
    for (const { framework: f } of group) {
      const m = got[f]?.[w.name]
      if (m === undefined) continue
      const ofCeil = m.ofCeiling === undefined ? "" : `${pad(pct(m.ofCeiling), 3)}% of ceiling`
      console.log(
        `    ${f.padEnd(15)} ${pad(Math.round(m.rps).toLocaleString(), 9)} req/s   ` +
          `p50 ${pad(m.p50ms.toFixed(2), 6)}ms   p99 ${pad(m.p99ms.toFixed(2), 7)}ms   ${ofCeil}`,
      )
    }
    const nifra = group.find((t) => t.framework.startsWith("nifra"))?.framework
    const elysia = group.find((t) => t.framework.startsWith("elysia"))?.framework
    const vsElysia =
      nifra !== undefined && elysia !== undefined
        ? pooledRatio([sampled], section.runtime, nifra, elysia, w.name)
        : undefined
    if (vsElysia !== undefined) console.log(`    → nifra is ${pct(vsElysia)}% of Elysia (paired)`)
    console.log("")
  }
}

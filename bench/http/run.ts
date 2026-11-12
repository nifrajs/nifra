/**
 * HTTP throughput matrix - nifra vs the field - driven by `oha` (a real Rust load
 * tool), sectioned by runtime. A section boots every framework's server at once, each
 * in its own subprocess on its own port, and warms each one per workload. It then
 * measures in interleaved rounds: a round takes one count-bounded oha sample of every
 * server, one server at a time, in the order bench/rounds.ts gives that round. Only the
 * sampled server carries load; the others sit idle. Identical routes + payloads across
 * every framework.
 *
 * READ THE RATIOS, NOT THE ABSOLUTES. This shares one (likely virtualized) box with
 * the load client, so absolute req/s moves with host load. A row's "% of ceiling" is
 * the median of its per-round ratios to the runtime's raw server, sampled seconds
 * apart in the same round, so drift that moves both samples cancels out of the ratio
 * even when it moves the absolutes. See BENCHMARKS.md.
 *
 *   bun run bench/http/run.ts            # every section this build knows
 *   bun run bench/http/run.ts bun        # one section only (bun | node | deno)
 */
import { loadavg } from "node:os"
import { cpuListFromEnv, pinned } from "../pinning.ts"
import {
  type Matrix,
  type Measure,
  mergeRuns,
  pooledRatio,
  pushRounds,
  roundOrder,
} from "../rounds.ts"

// Scale/warmup/round knobs are env-overridable for a fast pass (noisier, but the paired RATIO
// holds): `BENCH_SCALE=10 BENCH_WARMUP=0 BENCH_ROUNDS=2 …`. Defaults are the credible-numbers set.
const envInt = (name: string, dflt: number, min = 1): number => {
  const n = Bun.env[name] === undefined ? Number.NaN : Number(Bun.env[name])
  return Number.isInteger(n) && n >= min ? n : dflt
}
const CONNECTIONS = envInt("BENCH_CONNS", 50)
/** Scales every workload's request count (percent). `BENCH_SCALE=10` → a fast smoke pass. */
const SCALE_PCT = envInt("BENCH_SCALE", 100)
const WARMUP = envInt("BENCH_WARMUP", 1, 0) // 0 skips the warmup run
/** Rounded up to even: an unpaired round favours one end of its order (bench/rounds.ts). */
const ROUNDS = Math.ceil(envInt("BENCH_ROUNDS", 4) / 2) * 2
/** Shifts the round rotation, so repeated aggregate runs start from different rows. */
const ROUND_OFFSET = envInt("BENCH_ROUND_OFFSET", 0, 0)
const SERVER_CPUS = cpuListFromEnv("BENCH_SERVER_CPUS")
const LOAD_CPUS = cpuListFromEnv("BENCH_LOAD_CPUS")
const BASE_PORT = 3400

interface Workload {
  readonly name: string
  readonly path: string
  /** Requests per timed run. Runs are COUNT-bounded (`oha -n`), not duration-bounded
   *  (`-z`): a `-z` deadline aborts all 50 in-flight requests mid-body, and Deno.serve
   *  degrades badly after repeated mid-POST aborts (measured: 12K → 200 req/s for every
   *  subsequent run against ANY server in the section until the workload changed).
   *  Count-bounded runs end cleanly and the pathology never triggers. */
  readonly requests: number
  /** Exact valid response the runner checks before collecting throughput samples. */
  readonly expected: unknown
  readonly post?: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
}

const GET_ROOT: Workload = {
  name: "GET /",
  path: "/",
  requests: 150_000,
  expected: { hello: "world" },
}
const GET_USER: Workload = {
  name: "GET /users/:id",
  path: "/users/123",
  requests: 150_000,
  expected: { id: "123" },
}
const GET_SEARCH: Workload = {
  name: "GET /search?query",
  path: "/search?q=ada&limit=10",
  requests: 120_000,
  expected: { q: "ada", limit: "10" },
}
const POST_USERS: Workload = {
  name: "POST /users",
  path: "/users",
  requests: 100_000,
  expected: { id: "1", name: "Ada" },
  post: {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", age: 36 }),
  },
}

// Default is the meaningful pair - one read (routing + path param) + one write (body validation) -
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
  // Node 24 strips TS types natively - no build step (the spike confirmed it).
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
// Keep Fastify's Node HTTP server code identical under Bun and Deno; these rows measure each
// runtime's node:http compatibility path, not its native Fetch server.
const fastifyCompatTarget = (runtime: "bun" | "deno"): Target => ({
  framework: "fastify",
  spawn: (port) =>
    runtime === "bun"
      ? ["bun", "bench/http/serve-node.ts", "fastify", String(port)]
      : [
          "deno",
          "run",
          "--allow-net",
          "--allow-env",
          "--allow-read",
          "--no-check",
          "bench/http/serve-node.ts",
          "fastify",
          String(port),
        ],
})

// nifra on Node: real Node can't resolve the @nifrajs/* workspace packages (Bun resolves
// them via tsconfig paths, which Node ignores), so bundle the app for Node first - which
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
      fastifyCompatTarget("bun"),
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
      fastifyCompatTarget("deno"),
      { ...denoTarget("deno-raw"), isCeiling: true },
    ],
  },
]

const ceilingOf = (runtime: string): string | undefined =>
  SECTIONS.find((s) => s.runtime === runtime)?.targets.find((t) => t.isCeiling)?.framework

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined
}

/**
 * Parse oha's `--output-format json` at the trust boundary - it's external tool
 * output, so validate the shape rather than trusting property access. oha reports
 * latencies in SECONDS; we convert to ms here.
 */
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
  if (w.post) {
    args.push("-m", "POST", "-d", w.post.body)
    for (const [k, v] of Object.entries(w.post.headers)) args.push("-H", `${k}: ${v}`)
  }
  args.push(url)
  // Some shells export NO_COLOR=1; oha 1.14 expects a boolean-ish value, so normalize it for the child.
  const proc = Bun.spawn(pinned(["oha", ...args], LOAD_CPUS), {
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

async function probeWorkload(base: string, workload: Workload): Promise<void> {
  const init: RequestInit = { method: workload.post === undefined ? "GET" : "POST" }
  if (workload.post !== undefined) {
    init.headers = workload.post.headers
    init.body = workload.post.body
  }
  const response = await fetch(`${base}${workload.path}`, init)
  if (response.status !== 200) {
    throw new Error(`${workload.name}: correctness probe returned HTTP ${response.status}`)
  }
  const actual: unknown = await response.json()
  if (JSON.stringify(actual) !== JSON.stringify(workload.expected)) {
    throw new Error(`${workload.name}: correctness probe returned a different JSON response`)
  }
  if (workload === POST_USERS) {
    const invalid = await fetch(`${base}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    })
    if (invalid.status < 400 || invalid.status >= 500) {
      throw new Error(`${workload.name}: validator accepted an invalid body`)
    }
    const wrongType = await fetch(`${base}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", age: "36" }),
    })
    if (wrongType.status < 400 || wrongType.status >= 500) {
      throw new Error(`${workload.name}: validator accepted a string for numeric age`)
    }
    const withExtra = await fetch(`${base}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", age: 36, extra: true }),
    })
    if (withExtra.status !== 200) {
      throw new Error(`${workload.name}: validator rejected an extra body field`)
    }
  } else if (workload === GET_SEARCH) {
    const invalid = await fetch(`${base}/search?q=ada`)
    if (invalid.status < 400 || invalid.status >= 500) {
      throw new Error(`${workload.name}: validator accepted an incomplete query`)
    }
    const withExtra = await fetch(`${base}/search?q=ada&limit=10&extra=1`)
    if (withExtra.status !== 200) {
      throw new Error(`${workload.name}: validator rejected an extra query field`)
    }
  }
}

// sampled[runtime][framework][workload].rounds - one Measure per round, in round order.
const sampled: Matrix<{ rounds: Measure[] }> = {}
const failures: string[] = []

const argv = process.argv.slice(2)
// `--json` emits one machine-readable line (consumed by aggregate.ts to median across runs); the
// optional positional filters to one runtime section (`bun` | `node` | `deno`).
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
  const ceiling = ceilingOf(section.runtime)
  const servers: Server[] = []
  const failed = new Set<Target>()
  const fail = (target: Target, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`  ${section.runtime}/${target.framework}: ${msg}`)
    failures.push(`${section.runtime}/${target.framework}: ${msg}`)
    failed.add(target)
  }
  const live = (): Server[] => servers.filter((s) => !failed.has(s.target))
  try {
    let port = BASE_PORT
    for (const target of section.targets) {
      port += 1
      // Pin IPv4 loopback. `localhost` can resolve to ::1 first; Deno's default listener is IPv4-only on
      // this box, which made oha report connection-refused errors even though a browser/curl fallback
      // succeeded. A benchmark should not include DNS/address-family variance.
      const base = `http://127.0.0.1:${port}`
      try {
        if (target.prepare) await target.prepare()
        const proc = Bun.spawn(pinned(target.spawn(port), SERVER_CPUS), {
          stdout: "ignore",
          stderr: "inherit",
        })
        servers.push({ target, base, proc })
        await waitReady(base, 8000)
        for (const workload of WORKLOADS) await probeWorkload(base, workload)
      } catch (e) {
        fail(target, e)
      }
    }
    for (const w of WORKLOADS) {
      const requests = Math.max(500, Math.round((w.requests * SCALE_PCT) / 100))
      // warm the JIT for this workload
      if (WARMUP > 0) {
        for (const s of live()) {
          try {
            await runOha(`${s.base}${w.path}`, w, Math.round(requests / 5))
          } catch (e) {
            fail(s.target, e)
          }
        }
      }
      for (let round = 0; round < ROUNDS; round++) {
        for (const s of roundOrder(live(), round + ROUND_OFFSET)) {
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
        const line = live().map(({ target: { framework: f } }) => {
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
    await Bun.sleep(1500) // allow CPU to cool down and ports to clear
  }
}

if (failures.length > 0) {
  throw new Error(`benchmark results are invalid; ${failures.join("; ")}`)
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
    // `oha --version` => "oha 1.14.0"; `deno --version` => "deno 2.9.7"; `node --version` => "v26.10.0".
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
  scalePct: SCALE_PCT,
  connections: CONNECTIONS,
}

// `--json`: one line of machine-readable results for aggregate.ts, every round included so it can
// pool runs. No device/host/path info - only tool versions + the run knobs + the measured numbers.
// `ceilings` names each section's raw row, so a reader pairs rows without knowing SECTIONS.
if (jsonMode) {
  const ceilings: Record<string, Record<string, string>> = {}
  for (const section of sections) {
    const ceiling = ceilingOf(section.runtime)
    if (ceiling !== undefined) {
      ceilings[section.runtime] = Object.fromEntries(WORKLOADS.map((w) => [w.name, ceiling]))
    }
  }
  console.log(JSON.stringify({ meta, results, ceilings }))
  process.exit(0)
}

const versions = `Bun ${meta.bun} · Node ${meta.node} · Deno ${meta.deno}`
console.log(
  `\nHTTP throughput - oha, ${ROUNDS} interleaved rounds of count-bounded samples @ ${CONNECTIONS} conns  (${versions})\n% of ceiling is the median of per-round ratios to the runtime's raw server; req/s is the median round, indicative only.\n`,
)

for (const section of sections) {
  const got = results[section.runtime] ?? {}
  console.log(`## ${section.runtime}\n`)
  for (const w of WORKLOADS) {
    console.log(`  ${w.name}`)
    for (const { framework: f } of section.targets) {
      const m = got[f]?.[w.name]
      if (m === undefined) continue
      const ofCeil = m.ofCeiling === undefined ? "" : `${pad(pct(m.ofCeiling), 3)}% of ceiling`
      console.log(
        `    ${f.padEnd(10)} ${pad(Math.round(m.rps).toLocaleString(), 9)} req/s   ` +
          `p50 ${pad(m.p50ms.toFixed(2), 6)}ms   p99 ${pad(m.p99ms.toFixed(2), 7)}ms   ${ofCeil}`,
      )
    }
    const vsElysia = pooledRatio([sampled], section.runtime, "nifra", "elysia", w.name)
    if (vsElysia !== undefined) console.log(`    → nifra is ${pct(vsElysia)}% of Elysia (paired)`)
    console.log("")
  }
}

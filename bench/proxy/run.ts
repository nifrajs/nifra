/**
 * Reverse-proxy throughput matrix - `@nifrajs/proxy` vs the field - driven by `oha`, sectioned by
 * runtime. One shared upstream origin process (origin.ts) is spawned first and stays up for the
 * whole run; each proxy is then spawned ONE AT A TIME in its own subprocess, warmed, and sampled
 * N times with the MEDIAN kept.
 *
 * The first row measured is `direct` - oha against the origin with NO proxy in the path. Every
 * proxy row is reported as a percentage of it, which is the only number that travels: it says
 * "this proxy costs you X% of your origin's throughput" independent of how fast this box is.
 *
 * READ THE RATIOS, NOT THE ABSOLUTES. The load client, the proxy, and the origin all share one
 * box, so a proxied request crosses this machine's loopback twice and competes with the origin for
 * CPU. Absolute req/s is therefore much lower than a real deployment and is not publication-grade
 * - but every framework pays that identical tax in the SAME run.
 *
 * Rows are NOT feature-equivalent, and the table is a lie if you read it as one:
 *   - `direct` / `*-raw` do no hygiene at all - no hop-by-hop stripping, no timeout, redirects
 *     followed. They are the ceiling, not a proxy anyone should ship.
 *   - `@nifrajs/proxy` strips hop-by-hop AND Connection-nominated headers both ways, refuses to
 *     follow upstream redirects, enforces a deadline, and suppresses client-forged
 *     `X-Forwarded-*` unless explicitly opted in.
 *   - `@fastify/http-proxy` is undici-backed with its own connection pool - a genuinely different
 *     transport, not just a different API over `fetch`.
 *
 *   bun run bench/proxy/run.ts             # every section this build knows
 *   bun run bench/proxy/run.ts bun         # one section only (bun | node)
 *   BENCH_DURATION_S=2 BENCH_RUNS=1 bun run bench/proxy/run.ts    # fast, noisier pass
 */

const envInt = (name: string, dflt: number, min = 1): number => {
  const n = Bun.env[name] === undefined ? Number.NaN : Number(Bun.env[name])
  return Number.isInteger(n) && n >= min ? n : dflt
}
const CONNECTIONS = envInt("BENCH_CONNS", 50)
const DURATION_S = envInt("BENCH_DURATION_S", 4)
const WARMUP_S = envInt("BENCH_WARMUP_S", 2, 0)
const RUNS = envInt("BENCH_RUNS", 3)
const ORIGIN_PORT = 3600
const BASE_PORT = 3610

interface Workload {
  readonly name: string
  readonly path: string
  readonly post?: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
}

const WORKLOADS: readonly Workload[] = [
  { name: "GET /users/:id", path: "/users/123" },
  {
    name: "POST /users",
    path: "/users",
    post: {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", age: 36 }),
    },
  },
]

interface Target {
  readonly framework: string
  readonly spawn: (port: number) => readonly string[]
  readonly prepare?: () => Promise<void>
}

interface Section {
  readonly runtime: string
  readonly targets: readonly Target[]
}

const bunTarget = (framework: string): Target => ({
  framework,
  spawn: (port) => [
    "bun",
    "bench/proxy/serve-bun.ts",
    framework,
    String(port),
    String(ORIGIN_PORT),
  ],
})

const nodeTarget = (framework: string): Target => ({
  framework,
  spawn: (port) => [
    "node",
    "bench/proxy/serve-node.ts",
    framework,
    String(port),
    String(ORIGIN_PORT),
  ],
})

const NIFRA_NODE_BUNDLE = `${import.meta.dir}/dist/serve-node-nifra.js`
const nifraNodeTarget = (framework: string, mode: "fetch" | "undici"): Target => ({
  framework,
  prepare: async () => {
    const result = await Bun.build({
      entrypoints: [`${import.meta.dir}/serve-node-nifra.ts`],
      target: "node",
      outdir: `${import.meta.dir}/dist`,
      // Node loads the real client rather than an inlined copy - undici ships wasm.
      external: ["undici"],
    })
    if (!result.success) {
      throw new Error(`nifra-node bundle failed: ${result.logs.map(String).join("; ")}`)
    }
  },
  spawn: (port) => ["node", NIFRA_NODE_BUNDLE, String(port), String(ORIGIN_PORT), mode],
})

const SECTIONS: readonly Section[] = [
  {
    runtime: "bun",
    targets: [bunTarget("nifra"), bunTarget("nifra-bare"), bunTarget("hono"), bunTarget("bun-raw")],
  },
  {
    runtime: "node",
    targets: [
      nifraNodeTarget("nifra", "fetch"),
      nifraNodeTarget("nifra-undici", "undici"),
      nodeTarget("hono"),
      nodeTarget("fastify"),
      nodeTarget("node-raw"),
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

/** Parse oha's `--output-format json` at the trust boundary - external tool output, so validate
 *  the shape rather than trusting property access. oha reports latencies in SECONDS. */
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

async function sample(base: string, w: Workload): Promise<Measure> {
  if (WARMUP_S > 0) await runOha(`${base}${w.path}`, w, WARMUP_S)
  const runs: Measure[] = []
  for (let i = 0; i < RUNS; i++) runs.push(await runOha(`${base}${w.path}`, w, DURATION_S))
  const sorted = [...runs].sort((a, b) => a.rps - b.rps)
  return sorted[sorted.length >> 1] ?? ZERO
}

async function waitReady(base: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${base}/users/1`)
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

/**
 * Refuse to reuse a port something is ALREADY listening on. Without this the harness silently
 * benchmarks a stranger: the spawned server dies with EADDRINUSE, `waitReady` succeeds anyway
 * because the squatter answers, and the row reports a number belonging to a different process. An
 * orphan from an earlier interrupted run produced exactly that - a row that measured a leftover
 * server and came out backwards. A dead row must be a loud failure, never a plausible number.
 */
async function assertPortFree(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/users/1`)
  } catch {
    return // nothing listening - the port is ours
  }
  throw new Error(
    `port ${port} is already serving before we spawned anything - kill the orphan (lsof -nP -iTCP:${port} -sTCP:LISTEN) and rerun`,
  )
}

const argv = process.argv.slice(2)
const onlyRuntime = argv.find((a) => !a.startsWith("--"))
const sections = onlyRuntime ? SECTIONS.filter((s) => s.runtime === onlyRuntime) : SECTIONS
if (sections.length === 0) {
  throw new Error(
    `unknown runtime "${onlyRuntime}". known: ${SECTIONS.map((s) => s.runtime).join(", ")}`,
  )
}

await assertPortFree(ORIGIN_PORT)
const origin = Bun.spawn(["node", "bench/proxy/origin.ts", String(ORIGIN_PORT)], {
  stdout: "ignore",
  stderr: "inherit",
})
const originBase = `http://127.0.0.1:${ORIGIN_PORT}`
await waitReady(originBase, 10_000)

// results[runtime][framework][workload]
const results: Record<string, Record<string, Record<string, Measure>>> = {}
const direct: Record<string, Measure> = {}

try {
  console.log(
    `\nupstream origin on :${ORIGIN_PORT} - ${CONNECTIONS} conns, ${DURATION_S}s x${RUNS} (median), ${WARMUP_S}s warmup\n`,
  )
  for (const w of WORKLOADS) direct[w.name] = await sample(originBase, w)

  let portCursor = BASE_PORT
  for (const section of sections) {
    const runtimeRows: Record<string, Record<string, Measure>> = {}
    results[section.runtime] = runtimeRows
    for (const target of section.targets) {
      await target.prepare?.()
      const port = portCursor++
      const base = `http://127.0.0.1:${port}`
      await assertPortFree(port)
      const proc = Bun.spawn([...target.spawn(port)], { stdout: "ignore", stderr: "inherit" })
      try {
        await waitReady(base, 20_000)
        // The port was free before the spawn and something answers now, but the child could still
        // have exited between those two facts (a crash after bind, or a bind that lost a race).
        // Measuring then would attribute someone else's throughput to this row.
        if (proc.exitCode !== null) {
          throw new Error(
            `${section.runtime}/${target.framework} exited (code ${proc.exitCode}) but :${port} still answers - refusing to benchmark it`,
          )
        }
        const row: Record<string, Measure> = {}
        for (const w of WORKLOADS) row[w.name] = await sample(base, w)
        runtimeRows[target.framework] = row
      } finally {
        proc.kill()
        await proc.exited
      }
    }
  }
} finally {
  origin.kill()
  await origin.exited
}

const pad = (s: string, n: number): string => s.padEnd(n)
const num = (n: number): string => n.toLocaleString("en-US")

for (const w of WORKLOADS) {
  const baseline = direct[w.name] ?? ZERO
  console.log(`\n### ${w.name}   (direct-to-origin: ${num(baseline.rps)} req/s)\n`)
  console.log(
    `${pad("runtime", 9)}${pad("proxy", 14)}${pad("req/s", 12)}${pad("% of direct", 13)}${pad("p50 ms", 10)}p99 ms`,
  )
  console.log("-".repeat(66))
  for (const section of sections) {
    for (const target of section.targets) {
      const m = results[section.runtime]?.[target.framework]?.[w.name] ?? ZERO
      const pct = baseline.rps > 0 ? ((m.rps / baseline.rps) * 100).toFixed(1) : "-"
      console.log(
        `${pad(section.runtime, 9)}${pad(target.framework, 14)}${pad(num(m.rps), 12)}${pad(`${pct}%`, 13)}${pad(m.p50ms.toFixed(2), 10)}${m.p99ms.toFixed(2)}`,
      )
    }
  }
}
console.log("")

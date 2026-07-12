/**
 * Fast COMPARATIVE HTTP smoke-benchmark — nifra vs the field, ranked, in ~30s.
 *
 * The full suite (`bun run bench:http:update`) spawns every framework on every runtime across four
 * workloads, medianed over many runs — minutes to ~an hour. This runs ONE runtime section's whole
 * field on ONE workload with a single short `oha` run each, then prints a ranked table. Same servers
 * (serve*.ts) and same `oha` invocation as run.ts — right shape, fast.
 *
 *   bun run bench/http/quick.ts                  # node section (nifra·hono·fastify·express·elysia·raw)
 *   bun run bench/http/quick.ts bun              # bun section  (nifra·hono·elysia·raw)
 *   bun run bench/http/quick.ts deno /users/123  # deno section, on a chosen workload path
 *   bun run bench/http/quick.ts node post        # POST /users workload (validated body) instead of GET
 *
 * Default is `node` — the canonical backend field (the site's HTTP chart). Elysia is Bun-first but
 * runs on Node via its official adapter, so it's benched in both. READ THE RATIO, NOT THE ABSOLUTE:
 * this shares one box with the load client, so absolutes are noisy; the same-run ratio is the signal.
 */
const CONNECTIONS = 50
const WARMUP_S = 1
const DURATION_S = 2
const COOLDOWN_MS = 800
const BASE_PORT = 3490
const DIR = import.meta.dir

// Mirrors aggregate.ts's canonical sets (ceiling listed last). Elysia runs on all three (Bun-native,
// + its Node adapter and Web-Standard adapter on Deno), so it's benched in every section.
const SETS = {
  node: ["nifra", "hono", "fastify", "express", "elysia", "node-raw"],
  bun: ["nifra", "hono", "elysia", "bun-raw", "bun-native"],
  deno: ["nifra", "hono", "elysia", "deno-raw"],
} as const
type RuntimeKey = keyof typeof SETS
const CEILING = { node: "node-raw", bun: "bun-native", deno: "deno-raw" } as const
const isRuntime = (a: string): a is RuntimeKey => a in SETS

interface Measure {
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
}

const finiteNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined

const field = (obj: unknown, key: string): unknown =>
  typeof obj === "object" && obj !== null && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined

/** Parse `oha --output-format json` at the trust boundary — validate the shape, don't trust it. */
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

interface Post {
  readonly body: string
  readonly contentType: string
}

async function runOha(url: string, durationS: number, post?: Post): Promise<Measure> {
  const args = [
    "-c",
    String(CONNECTIONS),
    "-z",
    `${durationS}s`,
    "--no-tui",
    "--output-format",
    "json",
  ]
  if (post) args.push("-m", "POST", "-d", post.body, "-H", `content-type: ${post.contentType}`)
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

// nifra-on-Node needs a Node-targeted bundle (real Node can't resolve the @nifrajs/* workspace) —
// the same single-file bundle nifra deploys to Node as. Built once, lazily.
const NIFRA_NODE_BUNDLE = `${DIR}/dist/serve-node-nifra.js`
let nifraNodeBuilt = false
async function buildNifraNodeBundle(): Promise<void> {
  if (nifraNodeBuilt) return
  const result = await Bun.build({
    entrypoints: [`${DIR}/serve-node-nifra.ts`],
    target: "node",
    outdir: `${DIR}/dist`,
  })
  if (!result.success) {
    throw new Error(`nifra-node bundle failed: ${result.logs.map(String).join("; ")}`)
  }
  nifraNodeBuilt = true
}

/** The argv that boots `framework` on `runtime` at `port` (mirrors run.ts's targets). */
async function spawnArgv(runtime: string, framework: string, port: number): Promise<string[]> {
  const p = String(port)
  if (runtime === "bun") return ["bun", `${DIR}/serve.ts`, framework, p]
  if (runtime === "deno")
    // --allow-env: Elysia reads process.env.NODE_ENV at import; Node/Bun grant env by default, Deno doesn't.
    return [
      "deno",
      "run",
      "--allow-net",
      "--allow-env",
      "--no-check",
      `${DIR}/serve-deno.ts`,
      framework,
      p,
    ]
  // node
  if (framework === "nifra") {
    await buildNifraNodeBundle()
    return ["node", NIFRA_NODE_BUNDLE, p]
  }
  return ["node", `${DIR}/serve-node.ts`, framework, p]
}

/** Boot a framework server, warm the JIT, take one timed run, then kill it. */
async function measure(
  runtime: string,
  framework: string,
  port: number,
  path: string,
  post?: Post,
): Promise<Measure> {
  const base = `http://127.0.0.1:${port}` // pin IPv4 loopback — `localhost` can resolve to ::1 first
  const proc = Bun.spawn(await spawnArgv(runtime, framework, port), {
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    await waitReady(base, 10_000)
    await runOha(`${base}${path}`, WARMUP_S, post) // warm the JIT for this workload
    return await runOha(`${base}${path}`, DURATION_S, post)
  } finally {
    proc.kill()
    await proc.exited
  }
}

const argv = process.argv.slice(2)
const runtime: RuntimeKey = argv.find(isRuntime) ?? "node"
// `post` swaps to the POST /users workload (validated body); otherwise GET the given/default path.
const post = argv.includes("post")
const postConfig: Post | undefined = post
  ? { body: JSON.stringify({ name: "Ada", age: 36 }), contentType: "application/json" }
  : undefined
const path = post ? "/users" : (argv.find((a) => a.startsWith("/")) ?? "/users/123")
const label = post ? "POST /users" : `GET ${path}`
const frameworks = SETS[runtime]
const ceiling = CEILING[runtime]

const started = performance.now()
const rows: { fw: string; m: Measure | null }[] = []
for (const fw of frameworks) {
  let m: Measure | null = null
  try {
    m = await measure(runtime, fw, BASE_PORT + rows.length + 1, path, postConfig)
  } catch (e) {
    console.error(`  ${fw}: ${e instanceof Error ? e.message : String(e)}`)
  }
  rows.push({ fw, m })
  await Bun.sleep(COOLDOWN_MS) // let ports clear / CPU settle between servers
}

const nifraRps = rows.find((r) => r.fw === "nifra")?.m?.rps ?? 0
const ceilRps = rows.find((r) => r.fw === ceiling)?.m?.rps ?? 0
const ranked = [...rows].sort((a, b) => (b.m?.rps ?? -1) - (a.m?.rps ?? -1))

const pad = (s: string, n: number): string => s.padStart(n)
console.log(
  `\nquick HTTP bench — ${runtime} · ${label} · ${CONNECTIONS} conns · ${WARMUP_S}s warm + ${DURATION_S}s · bun ${Bun.version}`,
)
console.log(
  `  ${pad("framework", 11)} ${pad("req/s", 9)} ${pad("p50", 8)} ${pad("p99", 8)} ${pad("×nifra", 7)} ${pad("%ceil", 6)}`,
)
for (const { fw, m } of ranked) {
  if (!m) {
    console.log(`  ${pad(fw, 11)} ${pad("—", 9)}  (unavailable)`)
    continue
  }
  const xnifra = nifraRps > 0 ? (m.rps / nifraRps).toFixed(2) : "—"
  const pctCeil = ceilRps > 0 ? `${Math.round((m.rps / ceilRps) * 100)}%` : "—"
  const tag = fw === "nifra" ? " ★ nifra" : fw === ceiling ? " (ceiling)" : ""
  console.log(
    `  ${pad(fw, 11)} ${pad(m.rps.toLocaleString(), 9)} ${pad(`${m.p50ms.toFixed(2)}ms`, 8)} ${pad(`${m.p99ms.toFixed(2)}ms`, 8)} ${pad(xnifra, 7)} ${pad(pctCeil, 6)}${tag}`,
  )
}

const secs = ((performance.now() - started) / 1000).toFixed(1)
console.log(
  `\n(${secs}s — smoke signal only; ratios > absolutes. Run \`bun run bench:http:update\` for the medianed matrix.)`,
)

// Mark this script as a module so the top-level `await` above is allowed under the repo tsconfig.
export {}

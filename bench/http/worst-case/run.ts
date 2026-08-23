/**
 * WORST-CASE throughput matrix - nifra vs Elysia only, on Bun/Node/Deno - driven by
 * `oha`. The app under test deliberately misses every nifra fast tier at once (hooks +
 * multi-param route + validated query + untrusted JSON body + per-request dynamic
 * response headers), so this measures the GENERIC lane against Elysia's AOT-compiled
 * handler - the shape most likely to show nifra behind. Harness mechanics mirror
 * ../run.ts (isolated subprocess per server, warmup, median-of-N, ratios are the signal).
 *
 * Before any load run, each server is CORRECTNESS-PROBED (status, JSON fields, dynamic
 * headers) so a validation mismatch can never silently bench an error path.
 *
 *   bun run bench/http/worst-case/run.ts          # all sections (bun | node | deno)
 *   bun run bench/http/worst-case/run.ts bun      # one section
 */

const envInt = (name: string, dflt: number, min = 1): number => {
  const n = Bun.env[name] === undefined ? Number.NaN : Number(Bun.env[name])
  return Number.isInteger(n) && n >= min ? n : dflt
}
const CONNECTIONS = envInt("BENCH_CONNS", 50)
/** Scales every workload's request count (percent). `BENCH_SCALE=10` → a fast smoke pass. */
const SCALE_PCT = envInt("BENCH_SCALE", 100)
const WARMUP = envInt("BENCH_WARMUP", 1, 0) // 0 skips the warmup run
const RUNS = envInt("BENCH_RUNS", 3)
const BASE_PORT = 3520

// ---- workload payloads ------------------------------------------------------------

interface TaskItem {
  title: string
  done: boolean
  priority: number
  notes: string
}

function makeItems(n: number): TaskItem[] {
  const items: TaskItem[] = []
  for (let i = 0; i < n; i++) {
    items.push({ title: `task-${i}`, done: i % 2 === 0, priority: i % 5, notes: "x".repeat(64) })
  }
  return items
}

const BODY_SMALL = JSON.stringify({ items: makeItems(88) })
const BODY_LARGE = JSON.stringify({ items: makeItems(560) })
const kb = (s: string): string => `${(new TextEncoder().encode(s).length / 1024).toFixed(1)}KB`

const GET_PATH = "/orgs/acme/projects/apollo/tasks/42?verbose=1&trace=abc123"
const POST_PATH = "/orgs/acme/projects/apollo/tasks"

interface Workload {
  readonly name: string
  readonly path: string
  /** Requests per timed run. Runs are COUNT-bounded (`oha -n`), not duration-bounded
   *  (`-z`): a `-z` deadline aborts all 50 in-flight requests mid-body, and Deno.serve
   *  degrades badly after repeated mid-POST aborts (measured: 12K → 200 req/s for every
   *  subsequent run against ANY server in the section until the workload changed).
   *  Count-bounded runs end cleanly and the pathology never triggers. */
  readonly requests: number
  readonly post?: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
}

const JSON_CT = { "content-type": "application/json", "x-req-id": "bench-1" } as const

const WORKLOADS: readonly Workload[] = [
  {
    name: "GET worst (2 hooks + 3 params + query + dyn headers)",
    path: GET_PATH,
    requests: 100_000,
  },
  {
    name: `POST worst ${kb(BODY_SMALL)} body`,
    path: POST_PATH,
    requests: 30_000,
    post: { headers: JSON_CT, body: BODY_SMALL },
  },
  {
    name: `POST worst ${kb(BODY_LARGE)} body`,
    path: POST_PATH,
    requests: 10_000,
    post: { headers: JSON_CT, body: BODY_LARGE },
  },
]

// ---- targets ----------------------------------------------------------------------

interface Target {
  readonly framework: string
  readonly spawn: (port: number) => readonly string[]
  readonly prepare?: () => Promise<void>
}

interface Section {
  readonly runtime: string
  readonly targets: readonly Target[]
}

const NIFRA_NODE_BUNDLE = `${import.meta.dir}/../dist/serve-node-nifra-worst.js`
const nifraNodeTarget: Target = {
  framework: "nifra",
  prepare: async () => {
    const result = await Bun.build({
      entrypoints: [`${import.meta.dir}/serve-node-nifra-worst.ts`],
      target: "node",
      outdir: `${import.meta.dir}/../dist`,
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
      {
        framework: "nifra",
        spawn: (p) => ["bun", "bench/http/worst-case/serve.ts", "nifra", String(p)],
      },
      {
        framework: "elysia",
        spawn: (p) => ["bun", "bench/http/worst-case/serve.ts", "elysia", String(p)],
      },
    ],
  },
  {
    runtime: "node",
    targets: [
      nifraNodeTarget,
      {
        framework: "elysia",
        spawn: (p) => ["node", "bench/http/worst-case/serve-node-elysia.ts", String(p)],
      },
    ],
  },
  {
    runtime: "deno",
    targets: (["nifra", "elysia"] as const).map((framework) => ({
      framework,
      spawn: (p: number) => [
        "deno",
        "run",
        "--allow-net",
        "--allow-env",
        "--no-check",
        "bench/http/worst-case/serve-deno.ts",
        framework,
        String(p),
      ],
    })),
  },
]

// ---- oha plumbing (mirrors ../run.ts) ---------------------------------------------

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

async function runOha(url: string, w: Workload, requests: number): Promise<Measure> {
  const args = [
    "-c",
    String(CONNECTIONS),
    "-n",
    String(requests),
    "--no-tui",
    "--output-format",
    "json",
  ]
  if (w.post) {
    args.push("-m", "POST", "-d", w.post.body)
    for (const [k, v] of Object.entries(w.post.headers)) args.push("-H", `${k}: ${v}`)
  } else {
    args.push("-H", "x-req-id: bench-1")
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

function median(runs: readonly Measure[]): Measure {
  const sorted = [...runs].sort((a, b) => a.rps - b.rps)
  return sorted[sorted.length >> 1] ?? ZERO
}

async function waitReady(base: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`)
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
 * Correctness gate before any load run: the worst-case routes must return 200, the
 * expected JSON fields, and the DYNAMIC headers - otherwise we'd silently benchmark a
 * validation-rejection or error path and report a meaningless number.
 */
async function probe(base: string, framework: string): Promise<void> {
  const get = await fetch(`${base}${GET_PATH}`, { headers: { "x-req-id": "bench-1" } })
  const getBody: unknown = await get.json()
  if (
    get.status !== 200 ||
    get.headers.get("x-request-id") !== "bench-1" ||
    get.headers.get("x-trace") !== "abc123" ||
    field(getBody, "org") !== "acme" ||
    field(getBody, "id") !== "42"
  ) {
    throw new Error(`${framework}: GET probe failed (${get.status}): ${JSON.stringify(getBody)}`)
  }

  const post = await fetch(`${base}${POST_PATH}`, {
    method: "POST",
    headers: JSON_CT,
    body: BODY_SMALL,
  })
  const postBody: unknown = await post.json()
  if (
    post.status !== 200 ||
    post.headers.get("x-request-id") !== "bench-1" ||
    post.headers.get("x-count") !== "88" ||
    field(postBody, "count") !== 88 ||
    field(postBody, "first") !== "task-0"
  ) {
    throw new Error(`${framework}: POST probe failed (${post.status}): ${JSON.stringify(postBody)}`)
  }

  // The rejection path must also work (blocked by beforeHandle, invalid body rejected).
  const blocked = await fetch(`${base}${GET_PATH}`, { headers: { "x-block": "1" } })
  if (blocked.status !== 403)
    throw new Error(`${framework}: x-block probe expected 403, got ${blocked.status}`)
  await blocked.text()
  const invalid = await fetch(`${base}${POST_PATH}`, {
    method: "POST",
    headers: JSON_CT,
    body: JSON.stringify({ items: [{ title: 1 }] }),
  })
  if (invalid.status < 400)
    throw new Error(`${framework}: invalid-body probe expected 4xx, got ${invalid.status}`)
  await invalid.text()
}

// ---- run --------------------------------------------------------------------------

type Results = Record<string, Record<string, Record<string, Measure>>>
const results: Results = {}

const onlyRuntime = process.argv.slice(2).find((a) => !a.startsWith("--"))
const sections = onlyRuntime ? SECTIONS.filter((s) => s.runtime === onlyRuntime) : SECTIONS
if (sections.length === 0) {
  throw new Error(
    `unknown runtime "${onlyRuntime}". known: ${SECTIONS.map((s) => s.runtime).join(", ")}`,
  )
}

// PAIRED sampling: both frameworks' servers boot together (unique ports, idle when not
// measured), and each timed round alternates nifra → elysia before the next round. A
// multi-second background load spike on this shared box then degrades BOTH frameworks'
// same-round samples instead of silently sinking whichever server happened to be under
// the load client at that minute - the per-round RATIO stays honest even when the box
// is noisy. (An unpaired first cut produced deno POST rows swinging 0.2K-22K req/s.)
let nextPort = BASE_PORT
for (const section of sections) {
  const sectionResults: Record<string, Record<string, Measure>> = {}
  results[section.runtime] = sectionResults
  const running: { target: Target; base: string; proc: ReturnType<typeof Bun.spawn> }[] = []
  try {
    for (const target of section.targets) {
      nextPort += 1
      const base = `http://127.0.0.1:${nextPort}`
      if (target.prepare) await target.prepare()
      const proc = Bun.spawn([...target.spawn(nextPort)], { stdout: "ignore", stderr: "inherit" })
      running.push({ target, base, proc })
      await waitReady(base, 8000)
      await probe(base, `${section.runtime}/${target.framework}`)
      sectionResults[target.framework] = {}
    }
    for (const w of WORKLOADS) {
      const requests = Math.max(500, Math.round((w.requests * SCALE_PCT) / 100))
      if (WARMUP > 0) {
        for (const r of running) await runOha(`${r.base}${w.path}`, w, Math.round(requests / 5))
      }
      const perTarget = new Map<string, Measure[]>(running.map((r) => [r.target.framework, []]))
      for (let round = 0; round < RUNS; round++) {
        for (const r of running) {
          const m = await runOha(`${r.base}${w.path}`, w, requests)
          if (Bun.env.BENCH_TRACE === "1") {
            console.error(`    [round ${round}] ${r.target.framework} ${m.rps} req/s`)
          }
          perTarget.get(r.target.framework)?.push(m)
        }
      }
      for (const r of running) {
        const fw = sectionResults[r.target.framework]
        if (fw) fw[w.name] = median(perTarget.get(r.target.framework) ?? [])
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`  ${section.runtime}: ${msg}`)
  } finally {
    for (const r of running) {
      r.proc.kill()
      await r.proc.exited
    }
    await Bun.sleep(1500)
  }
}

// ---- report -----------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.padStart(n)
}

console.log(
  `\nWORST-CASE lane - oha, paired A/B, median-of-${RUNS} count-bounded runs @ ${CONNECTIONS} conns  ` +
    `(Bun ${Bun.version})\nRatios on the same run are the signal; absolutes are indicative only.\n`,
)

for (const section of sections) {
  const got = results[section.runtime] ?? {}
  console.log(`## ${section.runtime}\n`)
  for (const w of WORKLOADS) {
    console.log(`  ${w.name}`)
    for (const framework of ["nifra", "elysia"]) {
      const m = got[framework]?.[w.name] ?? ZERO
      console.log(
        `    ${framework.padEnd(7)} ${pad(m.rps.toLocaleString(), 9)} req/s   ` +
          `p50 ${pad(m.p50ms.toFixed(2), 6)}ms   p99 ${pad(m.p99ms.toFixed(2), 7)}ms`,
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

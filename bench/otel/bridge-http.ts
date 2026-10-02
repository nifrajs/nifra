/**
 * What the OTel SDK bridge's `around()` plugin costs on a real HTTP lane: `GET /users/:id` behind
 * `tracing()`, with and without `otelBridge().plugin` (AsyncLocalStorage context manager registered),
 * on Bun and on Node. Both servers stay up; count-bounded `oha` runs alternate between them and the
 * medians are compared. Read the ratio, not the absolute numbers.
 *
 *   bun run build && bun run scripts/link-for-node.ts   # Node loads the built dist
 *   bun run bench/otel/bridge-http.ts [bun|node] [rounds]
 */
const DIR = import.meta.dir
const CONNECTIONS = 50
const REQUESTS = 40_000
const WARMUP_REQUESTS = 10_000

interface Sample {
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
}

const num = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`oha: missing ${what}`)
  return value
}

async function oha(url: string, requests: number): Promise<Sample> {
  const proc = Bun.spawn(
    [
      "oha",
      "-n",
      String(requests),
      "-c",
      String(CONNECTIONS),
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
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every leaf is unknown and goes through num(), which accepts only a finite number.
  const json = JSON.parse(out) as {
    summary?: { requestsPerSec?: unknown; successRate?: unknown }
    latencyPercentiles?: { p50?: unknown; p99?: unknown }
  }
  if (num(json.summary?.successRate, "successRate") !== 1) throw new Error("oha: requests failed")
  return {
    rps: num(json.summary?.requestsPerSec, "requestsPerSec"),
    p50ms: num(json.latencyPercentiles?.p50, "p50") * 1000,
    p99ms: num(json.latencyPercentiles?.p99, "p99") * 1000,
  }
}

async function waitReady(url: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not listening yet
    }
    await Bun.sleep(100)
  }
  throw new Error(`server at ${url} never became ready`)
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const argv = process.argv.slice(2)
const runtimes = argv.filter((a) => a === "bun" || a === "node")
const rounds = Number(argv.find((a) => /^\d+$/.test(a)) ?? 5)
const variants = ["tracing", "bridge"] as const

for (const runtime of runtimes.length > 0 ? runtimes : ["bun", "node"]) {
  const procs = variants.map((variant, index) =>
    Bun.spawn([runtime, `${DIR}/serve-bridge.ts`, String(3610 + index), variant], {
      stdout: "ignore",
      stderr: "inherit",
    }),
  )
  try {
    const lanes: Array<{ url: string; samples: Sample[] }> = variants.map((_, index) => ({
      url: `http://127.0.0.1:${3610 + index}/users/42`,
      samples: [],
    }))
    for (const lane of lanes) await waitReady(lane.url)
    for (const lane of lanes) await oha(lane.url, WARMUP_REQUESTS)
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? lanes : [...lanes].reverse()
      for (const lane of order) lane.samples.push(await oha(lane.url, REQUESTS))
    }
    const [plain, bridged] = lanes.map(({ samples: list }) => ({
      rps: median(list.map((s) => s.rps)),
      p50ms: median(list.map((s) => s.p50ms)),
      p99ms: median(list.map((s) => s.p99ms)),
    }))
    if (plain === undefined || bridged === undefined) throw new Error("no samples")
    console.log(`\n  ${runtime}: GET /users/:id behind tracing(), ${rounds} rounds x ${REQUESTS}`)
    for (const [label, m] of [
      ["tracing()", plain],
      ["tracing() + bridge.plugin", bridged],
    ] as const) {
      console.log(
        `  ${label.padEnd(28)} ${Math.round(m.rps).toLocaleString().padStart(9)} req/s  p50 ${m.p50ms.toFixed(2)} ms  p99 ${m.p99ms.toFixed(2)} ms`,
      )
    }
    console.log(`  bridge / tracing              ${((bridged.rps / plain.rps) * 100).toFixed(1)}%`)
  } finally {
    for (const proc of procs) proc.kill()
    await Promise.all(procs.map((proc) => proc.exited))
  }
}

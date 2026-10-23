/**
 * S1 with real loader latency under saturation. Every loader reads one backend process: the
 * product's 20 ms catalog read and the per-visitor parts' 40, 150 and 400 ms reads. The backend serves
 * `SLOTS` reads at once, like a connection pool, and queues the rest first come first served, so a
 * loader's latency is its read plus the queue ahead of it. Closed-loop clients keep each of `LEVELS`
 * requests in flight: the first level stays under the pool's capacity, the others push past it.
 *
 * Per variant and level: requests per second, first byte and end p50/p99, hole frames that carried an
 * error, the server's CPU per request (idle subtracted) and its share of one core, and the backend's
 * reads per request and queue wait p50/p99. Requests started in a run's first `SETTLE_MS` fill the
 * queue and are left out of the rates and times.
 *
 * Gates, every level: no request fails, and a cached shell's first byte p50 stays under 2 ms however
 * long the backend's queue. Run: `bun bench/ppr/saturation.ts`, `FRAMEWORKS=react,svelte` for others
 * (default React: here the backend sets the pace, not the renderer); it exits 1 when a gate fails.
 */
import {
  cpuOf,
  freshId,
  idleCpuPerMs,
  type Listening,
  median,
  percentile,
  spawnUntilListening,
} from "./harness.ts"

// Bun's fetch sends at most 256 requests at once by default: a queue of its own, in the client and in
// the server's reads, in front of the backend's.
if (process.env.BUN_CONFIG_MAX_HTTP_REQUESTS === undefined) {
  const child = Bun.spawn(["bun", import.meta.path], {
    env: { ...process.env, BUN_CONFIG_MAX_HTTP_REQUESTS: "8192" },
    stdio: ["inherit", "inherit", "inherit"],
  })
  process.exit(await child.exited)
}

/** A request holds 610 ms of reads (590 with a cached shell), so 64 slots serve about 105 a second. */
const SLOTS = 64
const LEVELS = [32, 128, 384]
const DURATION_MS = 12_000
const SETTLE_MS = 2_000
const WARMUP_MS = 3_000
const ERROR_FRAME = '{"v":1,"error":true'

interface Variant {
  readonly name: string
  readonly path: string
  /** Whether every request reads product 1, whose shell is cached, or each a fresh product. */
  readonly cached: boolean
}
const VARIANTS: readonly Variant[] = [
  { name: "blocking SSR", path: "/blocking/", cached: true },
  { name: "defer() streaming", path: "/defer/", cached: true },
  { name: "PPR, 100% shell hits", path: "/ppr/", cached: true },
  { name: "PPR, 0% shell hits", path: "/ppr/", cached: false },
]
const pathFor = (variant: Variant): string =>
  `${variant.path}${variant.cached ? "1" : freshId()}?scale=1`

const upstream = await spawnUntilListening("upstream.ts", { UPSTREAM_SLOTS: String(SLOTS) })

interface BackendStats {
  readonly served: number
  readonly parts: number
  readonly inFlight: number
  readonly waitP50: number
  readonly waitP99: number
}
const backendStats = async (reset: boolean): Promise<BackendStats> =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the bench's backend process writes this shape (upstream.ts).
  (await (await fetch(`${upstream.origin}/__stats${reset ? "?reset" : ""}`)).json()) as BackendStats

/** Let reads a past run left behind finish: a hole past its deadline does not cancel its read. */
async function backendIdle(): Promise<void> {
  while ((await backendStats(false)).inFlight > 0) await Bun.sleep(100)
}

interface Sample {
  readonly ttfb: number
  readonly total: number
  readonly holeErrors: number
}
async function request(origin: string, path: string): Promise<Sample> {
  const started = performance.now()
  const response = await fetch(`${origin}${path}`, { headers: { cookie: "user=ada" } })
  if (response.status !== 200 || response.body === null) {
    throw new Error(`${path}: ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let first: number | undefined
  let page = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    first ??= performance.now() - started
    page += decoder.decode(value, { stream: true })
  }
  return {
    ttfb: first ?? Number.NaN,
    total: performance.now() - started,
    holeErrors: page.split(ERROR_FRAME).length - 1,
  }
}

async function drive(
  origin: string,
  variant: Variant,
  connections: number,
  durationMs: number,
  idle: number,
) {
  await backendIdle()
  const before = await backendStats(true)
  const cpu0 = await cpuOf(origin)
  const started = performance.now()
  const samples: Sample[] = []
  let completed = 0
  let failed = 0
  const worker = async () => {
    while (performance.now() - started < durationMs) {
      const at = performance.now() - started
      try {
        const sample = await request(origin, pathFor(variant))
        completed++
        if (at >= SETTLE_MS) samples.push(sample)
      } catch {
        failed++
      }
    }
  }
  await Promise.all(Array.from({ length: connections }, worker))
  const elapsedMs = performance.now() - started
  const cpu = (await cpuOf(origin)) - cpu0
  const after = await backendStats(false)
  return {
    samples,
    failed,
    rps: samples.length / ((durationMs - SETTLE_MS) / 1_000),
    cpuPerRequest: (cpu - idle * elapsedMs) / completed,
    cores: cpu / 1_000 / elapsedMs,
    catalogReads: (after.served - before.served) / completed,
    partReads: (after.parts - before.parts) / completed,
    waitP50: after.waitP50,
    waitP99: after.waitP99,
  }
}

const FRAMEWORKS = (process.env.FRAMEWORKS ?? "react").split(",")
const servers = new Map<string, Listening>()
for (const framework of FRAMEWORKS) {
  servers.set(
    framework,
    await spawnUntilListening("server.ts", {
      FRAMEWORK: framework,
      PPR_UPSTREAM: upstream.origin,
      PPR_PARTS_UPSTREAM: "1",
    }),
  )
}

const ms = (value: number): string => (value < 10 ? value.toFixed(2) : value.toFixed(0))
const failures: string[] = []
try {
  console.log(
    `## S1, every loader reading a backend of ${SLOTS} slots (catalog 20 ms, parts 40/150/400 ms), ${DURATION_MS / 1_000} s closed loop per row\n`,
  )
  console.log(
    "| framework | in flight | variant | req/s | first byte p50 / p99 | end p50 / p99 | hole error frames | CPU per request | server CPU | catalog / part reads per request | backend wait p50 / p99 |",
  )
  console.log("|---|---|---|---|---|---|---|---|---|---|---|")
  for (const [framework, server] of servers) {
    const idle = await idleCpuPerMs(server.origin)
    await request(server.origin, "/ppr/1?scale=1")
    await request(server.origin, "/ppr/1?scale=1")
    for (const variant of VARIANTS) {
      await drive(server.origin, variant, LEVELS[0] ?? 1, WARMUP_MS, idle)
    }
    for (const [index, level] of LEVELS.entries()) {
      const order = index % 2 === 0 ? VARIANTS : [...VARIANTS].reverse()
      const rows = new Map<string, string>()
      for (const variant of order) {
        const run = await drive(server.origin, variant, level, DURATION_MS, idle)
        const ttfb = run.samples.map((sample) => sample.ttfb)
        const total = run.samples.map((sample) => sample.total)
        const holeErrors = run.samples.reduce((sum, sample) => sum + sample.holeErrors, 0)
        rows.set(
          variant.name,
          `| ${framework} | ${level} | ${variant.name} | ${run.rps.toFixed(0)} | ${ms(median(ttfb))} / ${ms(percentile(ttfb, 0.99))} ms | ${ms(median(total))} / ${ms(percentile(total, 0.99))} ms | ${variant.path === "/ppr/" ? holeErrors : "-"} | ${run.cpuPerRequest.toFixed(0)} us | ${(run.cores * 100).toFixed(1)}% | ${run.catalogReads.toFixed(2)} / ${run.partReads.toFixed(2)} | ${ms(run.waitP50)} / ${ms(run.waitP99)} ms |`,
        )
        if (run.failed > 0)
          failures.push(`${framework} ${level} ${variant.name}: ${run.failed} failed`)
        if (variant.cached && variant.path === "/ppr/" && !(median(ttfb) < 2)) {
          failures.push(
            `${framework} ${level} in flight: cached first byte p50 ${median(ttfb).toFixed(2)} ms (gate 2 ms)`,
          )
        }
      }
      for (const variant of VARIANTS) console.log(rows.get(variant.name))
    }
  }
} finally {
  for (const { proc } of [...servers.values(), upstream]) proc.kill()
}
for (const failure of failures) console.log(`FAIL ${failure}`)
if (failures.length > 0) process.exit(1)
console.log("\nPASS: no request failed; a cached shell's first byte p50 stayed under 2 ms")

/**
 * Server cost of partial prerendering against nifra's blocking SSR and `defer()` streaming, and the
 * gates it must pass. Run: `bun bench/ppr/cost.ts`; it exits 1 when a gate fails.
 *
 *   S0  tiny page, zero loader delay                           pure render work, PPR's worst case
 *   S1  catalog read (20 ms, ~20 KB), holes at 40/150/400 ms   a realistic product page
 *
 * CPU per request is the server process's own CPU time over a load run divided by its requests; S1
 * subtracts the process's idle CPU over the run. Each load run is done twice with variants
 * interleaved, so run-to-run noise shows, after one unrecorded pass: a fresh process's first pass ran
 * up to 1.8x the CPU of its second. The PPR rows at 90, 50 and 0% shell hits draw a fresh
 * product id for the rest, so each of those requests builds its shell; the upstream column reads
 * back the hit rate the run got.
 *
 * Gates (S1, each framework): cached PPR CPU at most 0.75x blocking, cached TTFB p50 under 2 ms,
 * 0%-hit PPR CPU at most 1.2x `defer()`. A CPU gate takes the median of its ratio over
 * `GATE_ROUNDS` rounds, each running the four variants back to back in an order reversed every other
 * round, so a load spike from another process moves one round's ratio and not the verdict.
 */
import { join } from "node:path"

const here = import.meta.dir
const PASSES = 2
const WARMUP_PASSES = 1
const TTFB_ROUNDS = 25
const GATE_ROUNDS = 7
const GATE_REQUESTS = 1_500

async function spawnUntilListening(script: string, env: Record<string, string>) {
  const proc = Bun.spawn(["bun", join(here, script)], {
    env: { ...process.env, NODE_ENV: "production", ...env },
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = proc.stdout.getReader()
  let out = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`${script} exited before listening: ${out}`)
    out += new TextDecoder().decode(value)
    const origin = /on (http:\/\/\S+)/.exec(out)?.[1]
    if (origin !== undefined) {
      reader.releaseLock()
      return { proc, origin: origin.replace(/\/$/, "") }
    }
  }
}

const upstream = await spawnUntilListening("upstream.ts", {})
const FRAMEWORKS = ["react", "svelte"] as const
const servers = new Map<string, Awaited<ReturnType<typeof spawnUntilListening>>>()
for (const framework of FRAMEWORKS) {
  servers.set(`${framework} S0`, await spawnUntilListening("server.ts", { FRAMEWORK: framework }))
  servers.set(
    `${framework} S1`,
    await spawnUntilListening("server.ts", { FRAMEWORK: framework, PPR_UPSTREAM: upstream.origin }),
  )
}
const originOf = (key: string): string => {
  const server = servers.get(key)
  if (server === undefined) throw new Error(`no ${key} server`)
  return server.origin
}

interface Variant {
  readonly name: string
  readonly path: string
  /** The share of requests that reuse product 1's shell; the rest each read a fresh product. */
  readonly hits: number
}
const VARIANTS: readonly Variant[] = [
  { name: "blocking SSR", path: "/blocking/", hits: 1 },
  { name: "defer() streaming", path: "/defer/", hits: 1 },
  { name: "PPR, 100% shell hits", path: "/ppr/", hits: 1 },
  { name: "PPR, 90% shell hits", path: "/ppr/", hits: 0.9 },
  { name: "PPR, 50% shell hits", path: "/ppr/", hits: 0.5 },
  { name: "PPR, 0% shell hits", path: "/ppr/", hits: 0 },
]
const S0_VARIANTS = VARIANTS.filter((variant) => variant.hits === 1 || variant.hits === 0)
// Each gate's two sides run next to each other in every round.
const GATE_VARIANTS = [
  "blocking SSR",
  "PPR, 100% shell hits",
  "defer() streaming",
  "PPR, 0% shell hits",
]
  .map((name) => VARIANTS.find((variant) => variant.name === name))
  .filter((variant) => variant !== undefined)

// oha's URL regex reads `.` as itself, and an escaped one as something else, so dots stay as they are.
const regexEscape = (text: string): string => text.replace(/[?*+()[\]{}|^$\\]/g, "\\$&")

/** oha's `--rand-regex-url` picks an alternative uniformly, so `hits` tenths of them name product 1. */
function ohaTarget(origin: string, variant: Variant, scale: number): string[] {
  const query = `?scale=${scale}`
  if (variant.hits === 1) return [`${origin}${variant.path}1${query}`]
  const tenths = Math.round(variant.hits * 10)
  const ids = [
    ...Array<string>(tenths).fill("1"),
    ...Array<string>(10 - tenths).fill("u[a-z0-9]{20}"),
  ]
  return [
    "--rand-regex-url",
    `${regexEscape(`${origin}${variant.path}`)}(${ids.join("|")})${regexEscape(query)}`,
  ]
}

const freshId = (): string => `u${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
const pathFor = (variant: Variant, scale: number): string =>
  `${variant.path}${Math.random() < variant.hits ? "1" : freshId()}?scale=${scale}`

const cpuOf = async (origin: string): Promise<number> => {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the bench server's own /__cpu route returns process.cpuUsage().
  const usage = (await (await fetch(`${origin}/__cpu`)).json()) as { user: number; system: number }
  return usage.user + usage.system
}
const upstreamReads = async (): Promise<number> =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the bench's catalog process returns its read count.
  ((await (await fetch(`${upstream.origin}/__count`)).json()) as { served: number }).served

interface OhaSummary {
  readonly summary: { readonly requestsPerSec: number; readonly successRate: number }
  readonly statusCodeDistribution: Readonly<Record<string, number>>
}
function oha(target: readonly string[], n: number, connections: number): OhaSummary {
  const run = Bun.spawnSync([
    "oha",
    "-n",
    String(n),
    "-c",
    String(connections),
    "--no-tui",
    "--output-format",
    "json",
    "-H",
    "cookie: user=ada",
    ...target,
  ])
  if (run.exitCode !== 0) throw new Error(`oha failed: ${run.stderr.toString()}`)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: oha's documented JSON output.
  const result = JSON.parse(run.stdout.toString()) as OhaSummary
  const codes = Object.keys(result.statusCodeDistribution)
  if (result.summary.successRate !== 1 || codes.some((code) => code !== "200")) {
    throw new Error(`oha ${target.join(" ")}: ${JSON.stringify(result.statusCodeDistribution)}`)
  }
  return result
}

async function load(
  origin: string,
  variant: Variant,
  scale: number,
  n: number,
  connections: number,
) {
  const target = ohaTarget(origin, variant, scale)
  oha(target, Math.min(500, n), connections)
  const [cpu0, reads0, started] = [await cpuOf(origin), await upstreamReads(), performance.now()]
  const result = oha(target, n, connections)
  const [cpu1, reads1] = [await cpuOf(origin), await upstreamReads()]
  return {
    rps: result.summary.requestsPerSec,
    cpuPerRequest: (cpu1 - cpu0) / n,
    readsPerRequest: (reads1 - reads0) / n,
    elapsedMs: performance.now() - started,
  }
}

async function timeToFirstByte(origin: string, path: string) {
  const started = performance.now()
  const response = await fetch(`${origin}${path}`, { headers: { cookie: "user=ada" } })
  if (response.status !== 200 || response.body === null)
    throw new Error(`${path}: ${response.status}`)
  const reader = response.body.getReader()
  let first: number | undefined
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    first ??= performance.now()
    bytes += value.byteLength
  }
  return { ttfb: (first ?? performance.now()) - started, total: performance.now() - started, bytes }
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN
const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length

async function idleCpuPerMs(origin: string): Promise<number> {
  const before = await cpuOf(origin)
  const started = performance.now()
  await Bun.sleep(3_000)
  return ((await cpuOf(origin)) - before) / (performance.now() - started)
}

const failures: string[] = []
try {
  console.log("## S0: tiny page, zero loader delay (oha -n 20000 -c 32), two passes\n")
  console.log("| variant | req/s | CPU per request |")
  console.log("|---|---|---|")
  const s0 = new Map<string, { rps: number[]; us: number[] }>()
  for (let pass = 0; pass < WARMUP_PASSES + PASSES; pass++) {
    for (const framework of FRAMEWORKS) {
      const origin = originOf(`${framework} S0`)
      for (const variant of S0_VARIANTS) {
        const run = await load(origin, variant, 0, 20_000, 32)
        if (pass < WARMUP_PASSES) continue
        const key = `${framework} ${variant.name}`
        const entry = s0.get(key) ?? { rps: [], us: [] }
        entry.rps.push(run.rps)
        entry.us.push(run.cpuPerRequest)
        s0.set(key, entry)
      }
    }
  }
  for (const [key, entry] of s0) {
    console.log(
      `| ${key} | ${entry.rps.map((x) => x.toFixed(0)).join(" / ")} | ${entry.us.map((x) => x.toFixed(0)).join(" / ")} us |`,
    )
  }

  console.log(
    "\n## S1: catalog read (20 ms, ~20 KB), holes at 40/150/400 ms (oha -n 3000 -c 128)\n",
  )
  const rows: string[] = []
  for (const framework of FRAMEWORKS) {
    const origin = originOf(`${framework} S1`)
    const samples = new Map<string, { ttfb: number[]; total: number[]; bytes: number }>()
    for (const variant of VARIANTS) await timeToFirstByte(origin, pathFor(variant, 1))
    for (let round = 0; round < TTFB_ROUNDS; round++) {
      for (const variant of VARIANTS) {
        const sample = await timeToFirstByte(origin, pathFor(variant, 1))
        const entry = samples.get(variant.name) ?? { ttfb: [], total: [], bytes: 0 }
        entry.ttfb.push(sample.ttfb)
        entry.total.push(sample.total)
        entry.bytes = sample.bytes
        samples.set(variant.name, entry)
      }
    }
    const idle = await idleCpuPerMs(origin)
    const cost = new Map<string, { us: number[]; reads: number[] }>()
    const record = async (variant: Variant, n: number) => {
      const run = await load(origin, variant, 1, n, 128)
      const entry = cost.get(variant.name) ?? { us: [], reads: [] }
      entry.us.push(run.cpuPerRequest - (idle * run.elapsedMs) / n)
      entry.reads.push(run.readsPerRequest)
      cost.set(variant.name, entry)
    }
    for (let pass = 0; pass < WARMUP_PASSES; pass++) {
      for (const variant of VARIANTS) await load(origin, variant, 1, GATE_REQUESTS, 128)
    }
    for (let round = 0; round < GATE_ROUNDS; round++) {
      const order = round % 2 === 0 ? GATE_VARIANTS : [...GATE_VARIANTS].reverse()
      for (const variant of order) await record(variant, GATE_REQUESTS)
    }
    for (let pass = 0; pass < PASSES; pass++) {
      for (const variant of VARIANTS) {
        if (!GATE_VARIANTS.includes(variant)) await record(variant, 3_000)
      }
    }
    for (const variant of VARIANTS) {
      const t = samples.get(variant.name)
      const c = cost.get(variant.name)
      if (t === undefined || c === undefined) continue
      const us =
        c.us.length > PASSES
          ? `${median(c.us).toFixed(0)} us (${Math.min(...c.us).toFixed(0)}-${Math.max(...c.us).toFixed(0)})`
          : `${c.us.map((x) => x.toFixed(0)).join(" / ")} us`
      rows.push(
        `| ${framework} ${variant.name} | ${median(t.ttfb).toFixed(2)} ms | ${median(t.total).toFixed(1)} ms | ${t.bytes} | ${us} | ${mean(c.reads).toFixed(2)} |`,
      )
    }
    /** The median over rounds of one variant's CPU over another's, beside the rounds' range. */
    const ratio = (name: string, base: string): { median: number; range: string } => {
      const top = cost.get(name)?.us ?? []
      const bottom = cost.get(base)?.us ?? []
      const rounds = top.map((us, round) => us / (bottom[round] ?? Number.NaN))
      return {
        median: median(rounds),
        range: `${Math.min(...rounds).toFixed(2)}-${Math.max(...rounds).toFixed(2)}`,
      }
    }
    const cached = ratio("PPR, 100% shell hits", "blocking SSR")
    const uncached = ratio("PPR, 0% shell hits", "defer() streaming")
    const cachedTtfb = median(samples.get("PPR, 100% shell hits")?.ttfb ?? [])
    const gates: Array<readonly [string, boolean]> = [
      [
        `cached CPU ${cached.median.toFixed(2)}x blocking, median of ${GATE_ROUNDS} rounds ${cached.range} (gate 0.75x)`,
        cached.median <= 0.75,
      ],
      [`cached TTFB p50 ${cachedTtfb.toFixed(2)} ms (gate 2 ms)`, cachedTtfb < 2],
      [
        `0%-hit CPU ${uncached.median.toFixed(2)}x defer(), median of ${GATE_ROUNDS} rounds ${uncached.range} (gate 1.2x)`,
        uncached.median <= 1.2,
      ],
    ]
    console.log(`${framework}: idle CPU ${(idle * 1000).toFixed(0)} us per second, subtracted`)
    for (const [label, ok] of gates) {
      console.log(`${ok ? "PASS" : "FAIL"} ${framework}: ${label}`)
      if (!ok) failures.push(`${framework}: ${label}`)
    }
  }
  console.log(
    "\n| variant | TTFB p50 | complete p50 | bytes | CPU per request | catalog reads per request |",
  )
  console.log("|---|---|---|---|---|---|")
  for (const row of rows) console.log(row)
} finally {
  for (const { proc } of [...servers.values(), upstream]) proc.kill()
}
if (failures.length > 0) {
  console.error(`\n${failures.length} gate(s) failed`)
  process.exit(1)
}

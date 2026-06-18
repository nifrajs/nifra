/**
 * Prerendered (SSG) vs SSR TTFB — the same nifra + React app (examples/routing-react, which opts its
 * index route into `prerender = true`), served two ways:
 *   • SSG: the prerendered `dist/index.html` served as a static file (what a CDN/Workers Assets does).
 *   • SSR: the same route rendered on-demand by the nifra server.
 * Identical bytes; the only difference is file-read vs render. Quantifies the SSG TTFB win.
 *
 * Methodology mirrors bench:ssr — 127.0.0.1 (not localhost: avoids IPv6 ::1 refusals), a warmup, and
 * the median of N oha runs, with each run's successRate verified ≈100% before its numbers are trusted.
 * The two servers are measured SEQUENTIALLY (never concurrently), so neither steals the other's CPU.
 *
 *   bun run bench:prerender
 */
const HOST = "127.0.0.1"
const CONNECTIONS = 50
const DURATION_S = 5
const WARMUP_MS = 2000
const RUNS = 3
const SSR_PORT = 4410
const SSG_PORT = 4411
const DIST = `${import.meta.dir}/../../examples/routing-react/dist`

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

/** Parse oha JSON at the trust boundary; reject runs that didn't (almost) fully succeed. */
function parseOha(raw: string): Measure {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`oha: output was not JSON: ${raw.slice(0, 160)}`)
  }
  const summary = field(json, "summary")
  const rps = finiteNumber(field(summary, "requestsPerSec"))
  const success = finiteNumber(field(summary, "successRate"))
  const lat = field(json, "latencyPercentiles")
  const p50 = finiteNumber(field(lat, "p50"))
  const p99 = finiteNumber(field(lat, "p99"))
  if (rps === undefined || p50 === undefined || p99 === undefined || success === undefined) {
    throw new Error(`oha: unexpected JSON shape: ${raw.slice(0, 200)}`)
  }
  if (success < 0.99) {
    throw new Error(`oha: only ${(success * 100).toFixed(0)}% succeeded — server shed load`)
  }
  return { rps: Math.round(rps), p50ms: p50 * 1000, p99ms: p99 * 1000 }
}

async function runOha(url: string): Promise<Measure> {
  const env = { ...process.env }
  delete env.NO_COLOR
  delete env.CLERK_NO_COLOR
  const proc = Bun.spawn(
    [
      "oha",
      "-c",
      String(CONNECTIONS),
      "-z",
      `${DURATION_S}s`,
      "--no-tui",
      "--output-format",
      "json",
      url,
    ],
    { stdout: "pipe", stderr: "pipe", env },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`oha exited ${code}: ${err.slice(0, 200)}`)
  return parseOha(out)
}

async function waitReady(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url)
      await res.body?.cancel()
      if (res.ok) return
    } catch {
      // not up yet — retry
    }
    await Bun.sleep(100)
  }
  throw new Error(`server never became ready: ${url}`)
}

/** Start a server subprocess, warm it, take the median-of-N oha sample, then stop it. */
async function measure(
  label: string,
  cmd: readonly string[],
  env: Record<string, string>,
  port: number,
): Promise<Measure> {
  const proc = Bun.spawn([...cmd], {
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "pipe",
  })
  try {
    const url = `http://${HOST}:${port}/`
    await waitReady(url)
    await Bun.sleep(WARMUP_MS)
    const runs: Measure[] = []
    for (let i = 0; i < RUNS; i++) runs.push(await runOha(url))
    const sorted = [...runs].sort((a, b) => a.rps - b.rps)
    const median = sorted[sorted.length >> 1] ?? runs[0] ?? { rps: 0, p50ms: 0, p99ms: 0 }
    console.log(`  ${label}: ${median.rps} req/s · TTFB p50 ${median.p50ms.toFixed(2)}ms`)
    return median
  } finally {
    proc.kill()
    await proc.exited
  }
}

// Build routing-react (client + prerender → dist/index.html) so both servers have something to serve.
console.log("building examples/routing-react (client + SSG prerender)…")
const build = Bun.spawn(
  ["bun", "run", `${import.meta.dir}/../../examples/routing-react/build.ts`],
  {
    stdout: "ignore",
    stderr: "pipe",
  },
)
if ((await build.exited) !== 0) {
  throw new Error(`build failed: ${await new Response(build.stderr).text()}`)
}

console.log(
  `\nPrerendered (SSG) vs SSR TTFB — same nifra+React app, oha median-of-${RUNS} × ${DURATION_S}s @ ${CONNECTIONS} conns (Bun ${Bun.version})`,
)
const ssr = await measure(
  "SSR  (nifra renders /)        ",
  ["bun", `${import.meta.dir}/../../examples/routing-react/server.ts`],
  { PORT: String(SSR_PORT) },
  SSR_PORT,
)
const ssg = await measure(
  "SSG  (static dist/index.html)",
  ["bun", "run", `${import.meta.dir}/static-server.ts`],
  { PORT: String(SSG_PORT), DIST },
  SSG_PORT,
)

const ttfbDrop = ((1 - ssg.p50ms / ssr.p50ms) * 100).toFixed(0)
const rpsGain = (ssg.rps / Math.max(1, ssr.rps)).toFixed(1)
console.log(
  `\nSSG cuts TTFB p50 by ~${ttfbDrop}% (${ssr.p50ms.toFixed(2)}ms → ${ssg.p50ms.toFixed(2)}ms) and serves ~${rpsGain}× the req/s` +
    ` (${ssr.rps} → ${ssg.rps}).\nIdentical HTML — the win is serving a file vs rendering it. Use SSG for content that's the same for everyone; ISR when it changes occasionally.`,
)

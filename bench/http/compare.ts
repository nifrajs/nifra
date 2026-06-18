/**
 * End-to-end HTTP throughput: nifra vs Hono vs Elysia, on identical routes.
 *
 * Each server runs in its own subprocess (isolated from the load generator, so
 * the numbers actually discriminate). Load is self-generated from this process
 * with N concurrent keep-alive fetch workers. This is NOT a tuned external load
 * test (oha/autocannon on separate hardware) — treat the *ratios* as the signal.
 * Its job: show whether nifra is in the same class end-to-end, and whether the
 * router's per-request cost is even visible once real HTTP work dominates.
 */
const FRAMEWORKS = ["nifra", "hono", "elysia"] as const
const ROUTES = ["/", "/users/123"] as const
const BASE_PORT = 3100
const DURATION_MS = 3000
const CONCURRENCY = 50
const WARMUP_MS = 500

interface RouteResult {
  readonly route: string
  readonly rps: number
}

interface FrameworkResult {
  readonly framework: string
  readonly routes: readonly RouteResult[]
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
      // connection refused while the server boots — retry
    }
    await Bun.sleep(50)
  }
  throw new Error(`server at ${base} did not become ready within ${timeoutMs}ms`)
}

async function loadTest(url: string, durationMs: number, concurrency: number): Promise<number> {
  const deadline = performance.now() + durationMs
  let count = 0
  async function worker(): Promise<void> {
    while (performance.now() < deadline) {
      const res = await fetch(url)
      await res.text()
      count++
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return Math.round(count / (durationMs / 1000))
}

const results: FrameworkResult[] = []

for (let i = 0; i < FRAMEWORKS.length; i++) {
  const framework = FRAMEWORKS[i]!
  const port = BASE_PORT + i
  const base = `http://localhost:${port}`
  const proc = Bun.spawn(["bun", "run", "bench/http/serve.ts", framework, String(port)], {
    stdout: "ignore",
    stderr: "inherit",
  })
  try {
    await waitReady(base, 5000)
    await loadTest(`${base}/`, WARMUP_MS, 20) // warm the JIT before measuring
    const routes: RouteResult[] = []
    for (const route of ROUTES) {
      routes.push({ route, rps: await loadTest(`${base}${route}`, DURATION_MS, CONCURRENCY) })
    }
    results.push({ framework, routes })
  } catch (err) {
    console.error(`  ${framework}: failed — ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    proc.kill()
    await proc.exited
  }
}

console.log(
  `\n  HTTP throughput — Bun ${Bun.version}  (${CONCURRENCY} conns, ${DURATION_MS / 1000}s/route, self-generated load)\n`,
)
for (const route of ROUTES) {
  console.log(`  ${route}`)
  const rows = results.map((r) => ({
    framework: r.framework,
    rps: r.routes.find((x) => x.route === route)?.rps ?? 0,
  }))
  const best = Math.max(1, ...rows.map((x) => x.rps))
  for (const row of rows) {
    const pct = Math.round((row.rps / best) * 100)
    console.log(
      `    ${row.framework.padEnd(8)} ${row.rps.toLocaleString().padStart(10)} req/s   ${String(pct).padStart(3)}% of best`,
    )
  }
  console.log("")
}

export {}

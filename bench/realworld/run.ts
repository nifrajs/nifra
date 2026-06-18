/**
 * Realistic-shape HTTP throughput: nifra vs Elysia on identical work — security headers + CORS +
 * request-id + bearer-auth + cookie read + validated query + a ~3KB list response. Each server runs
 * in its own subprocess; load is self-generated from this process. Treat the *ratio* as the signal
 * (absolute rps is bounded by this host's load). Mirrors bench/http/compare.ts.
 */
const FRAMEWORKS = [
  { name: "nifra", file: "bench/realworld/nifra-rw.ts", port: 4501 },
  { name: "elysia", file: "bench/realworld/elysia-rw.ts", port: 4502 },
  { name: "hono", file: "bench/realworld/hono-rw.ts", port: 4503 },
] as const

const ROUTE = "/api/orders?limit=10"
const HEADERS: Record<string, string> = {
  authorization: "Bearer abcdefghijklmnopqrstuvwxyz", // ≥24 chars → passes the bearer guard (200, not 401)
  cookie: "theme=dark",
}
const DURATION_MS = 3000
const CONCURRENCY = 50
const WARMUP_MS = 700

async function waitReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      const res = await fetch(url, { headers: HEADERS })
      if (res.status === 200) {
        await res.text()
        return
      }
    } catch {
      // connection refused while the server boots — retry
    }
    await Bun.sleep(50)
  }
  throw new Error(`server at ${url} not ready (200) within ${timeoutMs}ms`)
}

async function loadTest(url: string, durationMs: number, concurrency: number): Promise<number> {
  const deadline = performance.now() + durationMs
  let count = 0
  async function worker(): Promise<void> {
    while (performance.now() < deadline) {
      const res = await fetch(url, { headers: HEADERS })
      await res.text()
      count++
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return Math.round(count / (durationMs / 1000))
}

const results: Array<{ name: string; rps: number }> = []
for (const fw of FRAMEWORKS) {
  const base = `http://localhost:${fw.port}`
  const proc = Bun.spawn(["bun", "run", fw.file], {
    env: { ...process.env, PORT: String(fw.port) },
    stdout: "ignore",
    stderr: "inherit",
  })
  try {
    await waitReady(`${base}${ROUTE}`, 5000)
    await loadTest(`${base}${ROUTE}`, WARMUP_MS, 20) // warm the JIT
    results.push({
      name: fw.name,
      rps: await loadTest(`${base}${ROUTE}`, DURATION_MS, CONCURRENCY),
    })
  } catch (err) {
    console.error(`  ${fw.name}: failed — ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    proc.kill()
    await proc.exited
  }
}

console.log(
  `\n  Realistic API throughput — Bun ${Bun.version}  (${CONCURRENCY} conns, ${DURATION_MS / 1000}s, GET ${ROUTE})\n`,
)
const best = Math.max(1, ...results.map((r) => r.rps))
for (const r of results) {
  console.log(
    `  ${r.name.padEnd(8)} ${r.rps.toLocaleString().padStart(10)} req/s   ${String(Math.round((r.rps / best) * 100)).padStart(3)}% of best`,
  )
}

export {}

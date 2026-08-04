/**
 * Tail latency under a MIXED workload - the gap uniform single-route benches hide.
 *
 *   bun run bench:p99            (env: DURATION_S=10 CONCURRENCY=32)
 *
 * Four route shapes round-robin per connection (bare GET, param GET, validated query GET,
 * validated JSON POST) against a real spawned server process; every request's latency is recorded
 * and the distribution reported. Honesty: the load client is this same machine and Bun's `fetch` -
 * client overhead is in the numbers, so read them as same-machine ratios and tail SHAPE, not as
 * wire-true absolutes.
 */
import { spawnServer } from "./_spawn.ts"

const DURATION_S = Number(Bun.env.DURATION_S ?? 10)
const CONCURRENCY = Number(Bun.env.CONCURRENCY ?? 32)

const { port, kill } = await spawnServer({})
const base = `http://127.0.0.1:${port}`
const POST_BODY = JSON.stringify({ name: "widget", qty: 3 })

type Shot = () => Promise<Response>
const SHOTS: Shot[] = [
  () => fetch(`${base}/`),
  () => fetch(`${base}/users/42`),
  () => fetch(`${base}/search?q=hello`),
  () =>
    fetch(`${base}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: POST_BODY,
    }),
]

const latencies: number[] = []
let errors = 0
const deadline = Bun.nanoseconds() + DURATION_S * 1e9
const percentile = (p: number): number =>
  latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] as number

async function worker(seed: number): Promise<void> {
  let i = seed
  while (Bun.nanoseconds() < deadline) {
    const shot = SHOTS[i++ % SHOTS.length] as Shot
    const start = Bun.nanoseconds()
    try {
      const res = await shot()
      await res.arrayBuffer() // drain - a benched request isn't done until its body is
      if (!res.ok) errors++
    } catch {
      errors++
    }
    latencies.push((Bun.nanoseconds() - start) / 1e6)
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)))
kill()

latencies.sort((a, b) => a - b)
const total = latencies.length
const p50 = percentile(50)
const p90 = percentile(90)
const p99 = percentile(99)
const p999 = percentile(99.9)
const max = latencies[total - 1] as number
console.log(`\nMixed workload - 4 route shapes, ${CONCURRENCY} conns, ${DURATION_S}s, same machine`)
console.log(
  `  requests   ${total.toLocaleString()}  (${Math.round(total / DURATION_S).toLocaleString()} req/s incl. client overhead)`,
)
console.log(`  errors     ${errors}`)
console.log(`  p50        ${p50.toFixed(2)} ms`)
console.log(`  p90        ${p90.toFixed(2)} ms`)
console.log(`  p99        ${p99.toFixed(2)} ms`)
console.log(`  p99.9      ${p999.toFixed(2)} ms`)
console.log(`  max        ${max.toFixed(2)} ms`)

if (Bun.env.NIFRA_PERF_GATE === "1") {
  const failures = [
    ...(errors === 0 ? [] : [`${errors} request error(s)`]),
    ...(p99 <= 2 ? [] : [`p99 ${p99.toFixed(2)} ms > 2 ms`]),
    ...(p999 <= 4 ? [] : [`p99.9 ${p999.toFixed(2)} ms > 4 ms`]),
  ]
  if (failures.length > 0)
    throw new Error(`performance standard failed:\n  ${failures.join("\n  ")}`)
  console.log("  standard  PASS (NIFRA_PERF_GATE=1)")
}

/**
 * Memory under sustained load — the leak check. A real server process is hammered with the mixed
 * workload while it samples its own RSS; flat-after-warmup is the pass, monotonic growth is the
 * red flag.
 *
 *   bun run bench:soak           (env: SOAK_S=60 CONCURRENCY=16)
 */
import { spawnServer } from "./_spawn.ts"

const SOAK_S = Number(Bun.env.SOAK_S ?? 60)
const CONCURRENCY = Number(Bun.env.CONCURRENCY ?? 16)

const { port, kill, lines } = await spawnServer({ RSS_EVERY_MS: "2000" })
const base = `http://127.0.0.1:${port}`
const POST_BODY = JSON.stringify({ name: "widget", qty: 3 })
const SHOTS = [
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

let requests = 0
const deadline = Bun.nanoseconds() + SOAK_S * 1e9
async function worker(seed: number): Promise<void> {
  let i = seed
  while (Bun.nanoseconds() < deadline) {
    const shot = SHOTS[i++ % SHOTS.length] as () => Promise<Response>
    try {
      const res = await shot()
      await res.arrayBuffer()
      requests++
    } catch {
      /* a dropped request shouldn't end the soak; RSS is the measurement */
    }
  }
}
console.log(`soaking ${SOAK_S}s at concurrency ${CONCURRENCY}…`)
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)))
// Let one final RSS sample land before reading them.
await Bun.sleep(2200)
kill()

const samples = lines
  .filter((l) => l.startsWith("rss "))
  .map((l) => Number(l.slice(4)) / (1024 * 1024))
if (samples.length < 3) {
  console.error("not enough RSS samples — soak too short?")
  process.exit(1)
}
const mb = (n: number): string => `${n.toFixed(1)} MB`
const first = samples[0] as number
const last = samples[samples.length - 1] as number
// Steady-state growth: compare the post-warmup sample (1/3 in) to the end — startup allocation
// (JIT, route compile, first-GC high-water) isn't leak signal.
const steady = samples[Math.floor(samples.length / 3)] as number
console.log(`\nMemory soak — ${requests.toLocaleString()} requests over ${SOAK_S}s`)
console.log(`  rss first sample   ${mb(first)}`)
console.log(`  rss post-warmup    ${mb(steady)}`)
console.log(`  rss last sample    ${mb(last)}`)
console.log(`  rss max            ${mb(Math.max(...samples))}`)
console.log(`  steady-state drift ${mb(last - steady)} over the final two-thirds`)
console.log(
  samples.length >= 5 ? `  samples: ${samples.map((s) => s.toFixed(0)).join(" → ")} MB` : "",
)

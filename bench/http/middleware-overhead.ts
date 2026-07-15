/**
 * In-process `app.fetch()` microbenchmark — no network, no load generator, so it
 * isolates the framework's per-request cost (route match → context → lifecycle →
 * handler → serialize). Measures a bare route vs. the same route behind a
 * derive + beforeHandle + afterHandle stack: the delta is the middleware overhead
 * and a check that the "compiled per-route chain" stays cheap.
 */
import { server } from "@nifrajs/core/server"

const bare = server().get("/users/:id", (c) => ({ id: c.params.id }))

const withMiddleware = server()
  .derive((c) => ({ requestId: c.req.headers.get("x-id") ?? "none" }))
  .beforeHandle(() => undefined)
  .afterHandle((result) => result)
  .get("/users/:id", (c) => ({ id: c.params.id }))

async function opsPerSec(
  app: { fetch: (req: Request) => Response | Promise<Response> },
  rounds: number,
  batch: number,
): Promise<number> {
  const req = new Request("http://localhost/users/42")
  for (let i = 0; i < 2000; i++) await app.fetch(req) // warm the JIT

  const perRoundNs = new Float64Array(rounds)
  for (let r = 0; r < rounds; r++) {
    const start = Bun.nanoseconds()
    for (let i = 0; i < batch; i++) await app.fetch(req)
    perRoundNs[r] = (Bun.nanoseconds() - start) / batch
  }
  perRoundNs.sort()
  const medianNs = perRoundNs[Math.floor(rounds / 2)] ?? 0
  return medianNs > 0 ? 1e9 / medianNs : 0
}

const bareOps = await opsPerSec(bare, 21, 5000)
const mwOps = await opsPerSec(withMiddleware, 21, 5000)
const overheadNs = 1e9 / mwOps - 1e9 / bareOps
const overheadPct = ((bareOps - mwOps) / bareOps) * 100

console.log(`\n  in-process app.fetch() — Bun ${Bun.version}\n`)
console.log(
  `  bare route                  ${Math.round(bareOps).toLocaleString().padStart(10)} req/s`,
)
console.log(
  `  + derive/before/after       ${Math.round(mwOps).toLocaleString().padStart(10)} req/s`,
)
console.log(
  `  middleware overhead         ${overheadPct.toFixed(1)}%  (${overheadNs.toFixed(0)} ns/req)\n`,
)

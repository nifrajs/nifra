/**
 * In-process `app.fetch()` microbenchmark - no network, no load generator, so it
 * isolates the framework's per-request cost (route match -> context -> lifecycle ->
 * handler -> serialize). Measures a bare route vs. the same route behind a
 * derive + beforeHandle + afterHandle stack: the delta is the middleware overhead
 * and a check that the "compiled per-route chain" stays cheap.
 */
import { server } from "@nifrajs/core/server"

type FetchApp = { fetch: (req: Request) => Response | Promise<Response> }

const median = (values: Float64Array): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const measureRoundNs = async (app: FetchApp, req: Request, batch: number): Promise<number> => {
  const start = Bun.nanoseconds()
  for (let i = 0; i < batch; i++) await app.fetch(req)
  return (Bun.nanoseconds() - start) / batch
}

/** Measure paired samples so shared-runner CPU drift affects both paths equally. */
async function measureMiddleware(
  bare: FetchApp,
  withMiddleware: FetchApp,
  rounds: number,
  batch: number,
): Promise<{ bareOps: number; mwOps: number; overheadNs: number; overheadPct: number }> {
  const bareReq = new Request("http://localhost/users/42")
  const middlewareReq = new Request("http://localhost/users/42")
  for (let i = 0; i < 2000; i++) {
    await bare.fetch(bareReq)
    await withMiddleware.fetch(middlewareReq)
  }

  const barePerRoundNs = new Float64Array(rounds)
  const middlewarePerRoundNs = new Float64Array(rounds)
  const pairedOverheadNs = new Float64Array(rounds)
  for (let r = 0; r < rounds; r++) {
    const firstBare = r % 2 === 0
    const first = firstBare
      ? await measureRoundNs(bare, bareReq, batch)
      : await measureRoundNs(withMiddleware, middlewareReq, batch)
    const second = firstBare
      ? await measureRoundNs(withMiddleware, middlewareReq, batch)
      : await measureRoundNs(bare, bareReq, batch)
    const bareNs = firstBare ? first : second
    const middlewareNs = firstBare ? second : first
    barePerRoundNs[r] = bareNs
    middlewarePerRoundNs[r] = middlewareNs
    pairedOverheadNs[r] = middlewareNs - bareNs
  }

  const bareNs = median(barePerRoundNs)
  const mwNs = median(middlewarePerRoundNs)
  const overheadNs = median(pairedOverheadNs)
  return {
    bareOps: bareNs > 0 ? 1e9 / bareNs : 0,
    mwOps: mwNs > 0 ? 1e9 / mwNs : 0,
    overheadNs,
    overheadPct: bareNs > 0 ? (overheadNs / bareNs) * 100 : Number.NaN,
  }
}

const CHECK = process.argv.includes("--check")
const MAX_OVERHEAD_PERCENT = 50
const MAX_OVERHEAD_NS = 250
const bare = server().get("/users/:id", (c) => ({ id: c.params.id }))
const withMiddleware = server()
  .derive((c) => ({ requestId: c.req.headers.get("x-id") ?? "none" }))
  .beforeHandle(() => undefined)
  .afterHandle((result) => result)
  .get("/users/:id", (c) => ({ id: c.params.id }))
const { bareOps, mwOps, overheadNs, overheadPct } = await measureMiddleware(
  bare,
  withMiddleware,
  21,
  5000,
)
console.log(`\n  in-process app.fetch() - Bun ${Bun.version}\n`)
console.log(
  `  bare route                  ${Math.round(bareOps).toLocaleString().padStart(10)} req/s`,
)
console.log(
  `  + derive/before/after       ${Math.round(mwOps).toLocaleString().padStart(10)} req/s`,
)
console.log(
  `  middleware overhead         ${overheadPct.toFixed(1)}%  (${overheadNs.toFixed(0)} ns/req)\n`,
)
if (CHECK) {
  const failures: string[] = []
  if (!Number.isFinite(overheadPct) || overheadPct > MAX_OVERHEAD_PERCENT)
    failures.push(`${overheadPct.toFixed(1)}% > ${MAX_OVERHEAD_PERCENT}%`)
  if (!Number.isFinite(overheadNs) || overheadNs > MAX_OVERHEAD_NS)
    failures.push(`${overheadNs.toFixed(0)} ns/req > ${MAX_OVERHEAD_NS} ns/req`)
  if (failures.length > 0)
    throw new Error(`middleware performance gate failed: ${failures.join("; ")}`)
  console.log(
    `middleware performance gate passed (limits ${MAX_OVERHEAD_PERCENT}% / ${MAX_OVERHEAD_NS} ns/req)`,
  )
}

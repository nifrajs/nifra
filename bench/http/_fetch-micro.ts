/** Scratch: per-request produce-side cost of app.fetch (no network). Median-of-7 sub-runs. */

import { server } from "../../packages/core/dist/server.js"
import { makeNifraApp } from "./_nifra-app.ts"

const app = makeNifraApp()
const N = 400_000
const WARMUP = 50_000
const SUBRUNS = 7
// This is deliberately a generous budget for a same-process smoke gate, not a publication number.
// It catches an accidental request-plan/dispatcher layer (or an allocation regression) without
// turning normal machine-to-machine jitter into a failed release.
const MAX_NS_PER_OP = 10_000
const CHECK = process.argv.includes("--check")
const MAX_FAST_PATH_RATIO = 1.5

const cases: Array<{ name: string; make: () => Request }> = [
  { name: "GET /          ", make: () => new Request("http://x/") },
  { name: "GET /users/:id ", make: () => new Request("http://x/users/123") },
]

async function medianNsPerOp(
  app: { fetch(request: Request): Response | Promise<Response> },
  make: () => Request,
): Promise<{ readonly median: number; readonly min: number }> {
  for (let i = 0; i < WARMUP; i++) await app.fetch(make())
  const samples: number[] = []
  for (let run = 0; run < SUBRUNS; run++) {
    const t0 = Bun.nanoseconds()
    for (let i = 0; i < N; i++) await app.fetch(make())
    samples.push((Bun.nanoseconds() - t0) / N)
  }
  samples.sort((a, b) => a - b)
  return {
    median: samples[Math.floor(SUBRUNS / 2)] ?? 0,
    min: samples[0] ?? 0,
  }
}

for (const { name, make } of cases) {
  const { median, min } = await medianNsPerOp(app, make)
  console.log(`${name} median ${median.toFixed(0)} / min ${min.toFixed(0)} ns/op`)
  if (CHECK && median > MAX_NS_PER_OP) {
    throw new Error(
      `core hot-path performance gate failed: ${name.trim()} median ${median.toFixed(0)} ns/op > ${MAX_NS_PER_OP} ns/op`,
    )
  }
}

const fast = server().get("/parity", () => ({ ok: true }))
const general = server()
  .beforeHandle(() => undefined)
  .get("/parity", () => ({ ok: true }))
const parityRequest = () => new Request("http://x/parity")
const fastMedian = (await medianNsPerOp(fast, parityRequest)).median
const generalMedian = (await medianNsPerOp(general, parityRequest)).median
console.log(`GET /parity fast ${fastMedian.toFixed(0)} / general ${generalMedian.toFixed(0)} ns/op`)
if (CHECK && fastMedian > generalMedian * MAX_FAST_PATH_RATIO) {
  throw new Error(
    `fast-path performance gate failed: fused ${fastMedian.toFixed(0)} ns/op > ${MAX_FAST_PATH_RATIO}× general ${generalMedian.toFixed(0)} ns/op`,
  )
}

if (CHECK) console.log(`core hot-path performance gate passed (budget ${MAX_NS_PER_OP} ns/op)`)

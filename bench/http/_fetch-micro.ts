/** Scratch: per-request produce-side cost of app.fetch (no network). Median-of-7 sub-runs. */
import { makeNifraApp } from "./_nifra-app.ts"

const app = makeNifraApp()
const N = 400_000
const WARMUP = 50_000
const SUBRUNS = 7

const cases: Array<{ name: string; make: () => Request }> = [
  { name: "GET /          ", make: () => new Request("http://x/") },
  { name: "GET /users/:id ", make: () => new Request("http://x/users/123") },
]

for (const { name, make } of cases) {
  for (let i = 0; i < WARMUP; i++) await app.fetch(make())
  const samples: number[] = []
  for (let run = 0; run < SUBRUNS; run++) {
    const t0 = Bun.nanoseconds()
    for (let i = 0; i < N; i++) await app.fetch(make())
    samples.push((Bun.nanoseconds() - t0) / N)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(SUBRUNS / 2)] ?? 0
  const min = samples[0] ?? 0
  console.log(`${name} median ${median.toFixed(0)} / min ${min.toFixed(0)} ns/op`)
}

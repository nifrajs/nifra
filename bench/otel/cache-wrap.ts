/**
 * In-process `cache.wrap()` hit-path microbenchmark: what an observer costs, and that a cache without
 * one pays nothing for the seam. Rows are measured in paired, order-alternating rounds and reported
 * as the median ns per call.
 *
 *   bun run bench/otel/cache-wrap.ts
 *   NIFRA_CACHE_BASELINE=/abs/path/to/other/cache/src/index.ts bun run bench/otel/cache-wrap.ts
 *
 * With NIFRA_CACHE_BASELINE (another checkout's `@nifrajs/cache` source, for example the commit before
 * the observer seam), a "baseline" row runs that copy so the no-observer row can be compared with it.
 */
import { createCache } from "@nifrajs/cache"
import { cacheTracing } from "../../packages/otel/src/cache.ts"

type WrapCache = {
  wrap<T>(key: string, loader: () => T): Promise<Awaited<T>>
  for(context: object): WrapCache
}

const ROUNDS = 61
const CALLS_PER_ROUND = 5_000
const TRACE = {
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
}

async function primed(cache: WrapCache): Promise<WrapCache> {
  await cache.wrap("user:42", () => ({ id: 42, name: "Ada" }))
  return cache
}

const rows: Array<{ label: string; run: () => Promise<unknown> }> = []
const loader = () => ({ id: 42, name: "Ada" })

const baselinePath = process.env.NIFRA_CACHE_BASELINE
if (baselinePath !== undefined) {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the path names a @nifrajs/cache source entry, whose createCache() returns a cache with this wrap().
  const baseline = (await import(baselinePath)) as { createCache: () => WrapCache }
  const cache = await primed(baseline.createCache())
  rows.push({ label: "baseline (NIFRA_CACHE_BASELINE)", run: () => cache.wrap("user:42", loader) })
}
{
  const cache = await primed(createCache())
  rows.push({ label: "no observer", run: () => cache.wrap("user:42", loader) })
}
{
  const cache = await primed(createCache({ observer: () => undefined }))
  rows.push({ label: "no-op observer", run: () => cache.wrap("user:42", loader) })
  const context = { trace: TRACE }
  rows.push({
    label: "no-op observer, for(c)",
    run: () => cache.for(context).wrap("user:42", loader),
  })
}
{
  const cache = await primed(createCache({ observer: cacheTracing({ exporter: { onEnd() {} } }) }))
  rows.push({ label: "cacheTracing, unbound (no span)", run: () => cache.wrap("user:42", loader) })
  const context = { trace: TRACE }
  rows.push({
    label: "cacheTracing, for(c) (one span)",
    run: () => cache.for(context).wrap("user:42", loader),
  })
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function round(run: () => Promise<unknown>): Promise<number> {
  const start = Bun.nanoseconds()
  for (let i = 0; i < CALLS_PER_ROUND; i++) await run()
  return (Bun.nanoseconds() - start) / CALLS_PER_ROUND
}

for (const row of rows) for (let i = 0; i < 20_000; i++) await row.run()
const samples = rows.map((): number[] => [])
for (let r = 0; r < ROUNDS; r++) {
  // Rotate the starting row so drift and JIT tiering hit every row equally.
  for (let i = 0; i < rows.length; i++) {
    const index = (i + r) % rows.length
    const row = rows[index]
    if (row !== undefined) samples[index]?.push(await round(row.run))
  }
}

// Per-round paired deltas against the no-observer row cancel the drift both rows saw in that round.
const referenceIndex = rows.findIndex((row) => row.label === "no observer")
const reference = samples[referenceIndex] ?? []
console.log(
  `\n  cache.wrap() fresh hit - Bun ${Bun.version}, ${ROUNDS} rounds x ${CALLS_PER_ROUND}\n`,
)
console.log(`  ${"row".padEnd(36)} ${"median".padStart(8)}           paired delta vs no observer`)
for (const [index, row] of rows.entries()) {
  const own = samples[index] ?? []
  const deltas = own.map((ns, r) => ns - (reference[r] ?? ns))
  const deltaNs = median(deltas)
  const deltaPct = (deltaNs / median(reference)) * 100
  console.log(
    `  ${row.label.padEnd(36)} ${median(own).toFixed(1).padStart(8)} ns/call  ${deltaNs >= 0 ? "+" : ""}${deltaNs.toFixed(1)} ns (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`,
  )
}
console.log()

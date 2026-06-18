/**
 * The website's benchmark numbers, as a single source of truth. The data lives in `benchmarks.json`
 * (machine-readable) so the bench suite can update it on every run — see `bench/site-bench.ts`, which
 * `bun run bench:http:update` / `bench:ssr` / `bench:size` call to merge their slice. The site imports
 * the typed slices below, so a fresh run flows straight to the landing + /benchmarks with no hand-edit.
 */

import data from "./benchmarks.json"

/** A bar-chart row: a framework's req/s (higher is better); `you` flags Nifra's rows. */
export interface BenchRow {
  readonly name: string
  readonly reqs: number
  readonly you?: boolean
}

/** A headline multiplier: nifra+`fw` vs its meta-framework `rival`. */
export interface Multiplier {
  readonly fw: string
  readonly mult: string
  readonly rival: string
}

/** Nifra HTTP throughput on one runtime (GET / JSON). */
export interface HttpRuntimeRow {
  readonly runtime: string
  readonly reqs: number
  readonly pctOfRaw: number
  readonly you?: boolean
}

/** A gzipped server-bundle size row (lower is better). */
export interface BundleRow {
  readonly name: string
  readonly kb: number
  readonly you?: boolean
}

/** A hero proof stat (value + label). */
export interface ProofStat {
  readonly value: string
  readonly label: string
}

export const HERO_SSR = data.heroSsr as readonly BenchRow[]
export const FRONTEND = data.frontend as readonly BenchRow[]
export const MULTIPLIERS = data.multipliers as readonly Multiplier[]
export const HTTP_RUNTIME = data.httpRuntime as readonly HttpRuntimeRow[]
export const HTTP_BENCH = data.http as readonly BenchRow[]
export const BUNDLE = data.bundle as readonly BundleRow[]
export const PROOF = data.proof as readonly ProofStat[]

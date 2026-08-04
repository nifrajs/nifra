/**
 * The website's benchmark numbers, as a single source of truth. The data lives in `benchmarks.json`
 * (machine-readable) so the bench suite can update it on every run - see `bench/site-bench.ts`, which
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

/** One measured HTTP workload row, shared by the benchmarks page and comparison articles. */
export interface HttpWorkloadRow {
  readonly name: string
  readonly getUsers: string
  readonly postUsers: string
  readonly nifra?: boolean
}

/** Per-runtime HTTP workload table from the canonical benchmark dataset. */
export interface HttpWorkloadTable {
  readonly title: string
  readonly rows: readonly HttpWorkloadRow[]
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

/** A /benchmarks SSR table row (display-ready; `jsGzKb` = gzipped client JS in KB). */
export interface SsrTableRow {
  readonly name: string
  readonly runtime: "bun" | "node"
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
  readonly jsGzKb: number
  readonly nifra?: boolean
}

/** A per-framework SSR group - one table section per UI framework on /benchmarks. */
export interface SsrTable {
  readonly framework: string
  readonly rows: readonly SsrTableRow[]
}

export const HERO_SSR = data.heroSsr as readonly BenchRow[]
export const SSR_TABLES = data.ssrTables as readonly SsrTable[]
// Table B (cacheable: SSG/ISR) - rendered as separately-labelled tables, never blended with Table A.
export const SSR_TABLES_B = ((data as { ssrTablesB?: readonly SsrTable[] }).ssrTablesB ??
  []) as readonly SsrTable[]
export const FRONTEND = data.frontend as readonly BenchRow[]
export const MULTIPLIERS = data.multipliers as readonly Multiplier[]
export const HTTP_RUNTIME = data.httpRuntime as readonly HttpRuntimeRow[]
export const HTTP_BENCH = data.http as readonly BenchRow[]
export const HTTP_WORKLOADS = data.httpWorkloads as readonly HttpWorkloadTable[]
export const BUNDLE = data.bundle as readonly BundleRow[]
export const PROOF = data.proof as readonly ProofStat[]

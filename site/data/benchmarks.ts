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

/** A realistic-shape HTTP row: the same route carrying what a real API route carries. */
export interface HttpRealworldRow {
  readonly name: string
  readonly get: string
  readonly post: string
  /** The GET again, plus one body-observing middleware. */
  readonly body: string
  readonly nifra?: boolean
}

/** Per-runtime realistic-shape HTTP table from the canonical benchmark dataset. */
export interface HttpRealworldTable {
  readonly title: string
  readonly rows: readonly HttpRealworldRow[]
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
// The realistic-shape slice. Defaulted like SSR_TABLES_B: the aggregate only writes it when all
// three runtimes ran, so a dataset from a partial run legitimately has no key here.
export const HTTP_REALWORLD = ((data as { httpRealworld?: readonly HttpRealworldTable[] })
  .httpRealworld ?? []) as readonly HttpRealworldTable[]
export const BUNDLE = data.bundle as readonly BundleRow[]
export const PROOF = data.proof as readonly ProofStat[]

export type HttpWorkloadMetric = "getUsers" | "postUsers"
export type HttpRealworldMetric = "get" | "post" | "body"

function parseRps(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value.replaceAll(",", ""))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Read a measured bare HTTP workload from the canonical benchmark dataset. */
export function httpWorkloadRps(
  runtime: string,
  framework: string,
  workload: HttpWorkloadMetric,
): number | undefined {
  const value = HTTP_WORKLOADS.find((table) => table.title === runtime)?.rows.find(
    (row) => row.name === framework,
  )?.[workload]
  return parseRps(value)
}

/** Read a measured HTTP workload with auth and middleware from the same dataset. */
export function httpRealworldRps(
  runtime: string,
  framework: string,
  workload: HttpRealworldMetric,
): number | undefined {
  const value = HTTP_REALWORLD.find((table) => table.title === runtime)?.rows.find(
    (row) => row.name === framework,
  )?.[workload]
  return parseRps(value)
}

/** Read a Nifra SSR result for a UI framework and runtime. */
export function ssrRps(framework: string, runtime: "bun" | "node"): number | undefined {
  return SSR_TABLES.find((table) => table.framework === framework)?.rows.find(
    (row) => row.nifra && row.runtime === runtime,
  )?.rps
}

/** Read a named framework result from the canonical SSR tables. */
export function ssrFrameworkRps(name: string, runtime: "bun" | "node"): number | undefined {
  for (const table of SSR_TABLES) {
    const result = table.rows.find((row) => row.name.startsWith(name) && row.runtime === runtime)
    if (result) return result.rps
  }
  return undefined
}

/** The runtime-ceiling percentage reported by the HTTP suite. */
export function runtimeCeilingPercent(runtime: string): number | undefined {
  return HTTP_RUNTIME.find((row) => row.runtime === runtime)?.pctOfRaw
}

/** Round a measured value against its comparison value to a whole percentage. */
export function percentOf(
  value: number | undefined,
  comparison: number | undefined,
): number | undefined {
  if (value === undefined || comparison === undefined || comparison === 0) return undefined
  return Math.round((value / comparison) * 100)
}

/** Format benchmark values consistently in the site and its comparison articles. */
export function formatRps(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toLocaleString("en-US")
}

export function formatPercent(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value)}%`
}

export function formatRatio(value: number | undefined, comparison: number | undefined): string {
  if (value === undefined || comparison === undefined || comparison === 0) return "n/a"
  return `${(value / comparison).toFixed(1)}x`
}

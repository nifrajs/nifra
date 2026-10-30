/**
 * The website's benchmark numbers, as a single source of truth. The data lives in `benchmarks.json`
 * (machine-readable) so the bench suite can update it on every run - see `bench/site-bench.ts`, which
 * `bun run bench:http:update` / `bench:ssr` / `bench:size` call to merge their slice. The site imports
 * the typed slices below, so a fresh run flows straight to the landing + /benchmarks with no hand-edit.
 * Every row names the version it measured; the raw-runtime rows the suites measure against are not
 * published (bench/site-bench.ts).
 */

import data from "./benchmarks.json"
import type { HttpMemoryCapture } from "./memory-types"

/** A bar-chart row: a framework's req/s (higher is better); `you` flags Nifra's rows. */
export interface BenchRow {
  readonly name: string
  readonly version: string
  readonly reqs: number
  readonly you?: boolean
}

/** A headline multiplier: nifra+`fw` vs its meta-framework `rival`. */
export interface Multiplier {
  readonly fw: string
  readonly mult: string
  readonly rival: string
  readonly rivalVersion: string
}

/** When and with which toolchain a slice was measured; `deno` is absent for a suite that skips it. */
export interface CapturedMeta {
  readonly date: string
  readonly bun: string
  readonly node: string
  readonly deno?: string
  readonly oha: string
}

/** One measured HTTP workload row, shared by the benchmarks page and comparison articles. */
export interface HttpWorkloadRow {
  readonly name: string
  readonly version: string
  readonly getUsers: string
  readonly postUsers: string
  readonly nifra?: boolean
}

/** Per-runtime HTTP workload table from the canonical benchmark dataset. */
export interface HttpWorkloadTable {
  readonly title: string
  /** The runtime's version. */
  readonly version: string
  readonly rows: readonly HttpWorkloadRow[]
}

/** A realistic-shape HTTP row: the same route carrying what a real API route carries. */
export interface HttpRealworldRow {
  readonly name: string
  readonly version: string
  readonly get: string
  readonly post: string
  /** The GET again, plus one body-observing middleware. */
  readonly body: string
  readonly nifra?: boolean
}

/** Per-runtime realistic-shape HTTP table from the canonical benchmark dataset. */
export interface HttpRealworldTable {
  readonly title: string
  /** The runtime's version. */
  readonly version: string
  readonly rows: readonly HttpRealworldRow[]
}

/** A gzipped server-bundle size row (lower is better). */
export interface BundleRow {
  readonly name: string
  readonly version: string
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
  readonly version: string
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

function multiplierValue(item: Multiplier): number {
  const value = Number.parseFloat(item.mult)
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

export const HERO_SSR = data.heroSsr as readonly BenchRow[]
export const SSR_TABLES = data.ssrTables as readonly SsrTable[]
// Table B (cacheable: SSG/ISR) - rendered as separately-labelled tables, never blended with Table A.
export const SSR_TABLES_B = ((data as { ssrTablesB?: readonly SsrTable[] }).ssrTablesB ??
  []) as readonly SsrTable[]
export const FRONTEND = data.frontend as readonly BenchRow[]
// Largest first, ordered by the published value so a refreshed dataset re-ranks itself.
export const MULTIPLIERS = [...(data.multipliers as readonly Multiplier[])].sort(
  (a, b) => multiplierValue(b) - multiplierValue(a),
)
export const HTTP_BENCH = data.http as readonly BenchRow[]
export const HTTP_WORKLOADS = data.httpWorkloads as readonly HttpWorkloadTable[]
// The realistic-shape slice. Defaulted like SSR_TABLES_B: the aggregate only writes it when all
// three runtimes ran, so a dataset from a partial run legitimately has no key here.
export const HTTP_REALWORLD = ((data as { httpRealworld?: readonly HttpRealworldTable[] })
  .httpRealworld ?? []) as readonly HttpRealworldTable[]
export const BUNDLE = data.bundle as readonly BundleRow[]
export const PROOF = data.proof as readonly ProofStat[]
/** A UI framework's headline dynamic-SSR multiplier over its meta-framework, as published. */
export function ssrMultiplier(framework: string): string {
  return MULTIPLIERS.find((item) => item.fw === framework)?.mult ?? "n/a"
}

export const HTTP_WORKLOADS_CAPTURED: CapturedMeta = data.httpWorkloadsCaptured
export const HTTP_REALWORLD_CAPTURED: CapturedMeta = data.httpRealworldCaptured
export const HTTP_MEMORY = Object.values(data.httpMemory ?? {})
  .filter((capture): capture is HttpMemoryCapture => capture !== undefined)
  .sort(
    (a, b) =>
      ["node", "bun", "deno"].indexOf(a.runtime) - ["node", "bun", "deno"].indexOf(b.runtime),
  )
export const SSR_CAPTURED: CapturedMeta = data.ssrCaptured

export type HttpWorkloadMetric = "getUsers" | "postUsers"
export type HttpRealworldMetric = "get" | "post" | "body"

function parseRps(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value.replaceAll(",", ""))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** A framework's bare HTTP row on a runtime, with the version it measured. */
export function httpWorkloadRow(runtime: string, framework: string): HttpWorkloadRow | undefined {
  return HTTP_WORKLOADS.find((table) => table.title === runtime)?.rows.find(
    (row) => row.name === framework,
  )
}

/** Nifra's bare GET against the fastest other row of the same runtime table. */
export interface HttpGetTrail {
  readonly nifra: HttpWorkloadRow
  readonly rival: HttpWorkloadRow
  /** How far Nifra's req/s sits below the rival's, in percent of the rival's. */
  readonly behindPercent: number
}

/** The bare-GET gap on a runtime, or undefined when Nifra leads that table or a row is missing. */
export function httpGetTrail(runtime: string): HttpGetTrail | undefined {
  const rows = HTTP_WORKLOADS.find((table) => table.title === runtime)?.rows ?? []
  const nifra = rows.find((row) => row.nifra)
  const nifraRps = parseRps(nifra?.getUsers)
  if (nifra === undefined || nifraRps === undefined) return undefined
  let rival: HttpWorkloadRow | undefined
  let rivalRps = nifraRps
  for (const row of rows) {
    const rps = parseRps(row.getUsers)
    if (row.nifra || rps === undefined || rps <= rivalRps) continue
    rival = row
    rivalRps = rps
  }
  if (rival === undefined) return undefined
  return { nifra, rival, behindPercent: (1 - nifraRps / rivalRps) * 100 }
}

/** Read a measured bare HTTP workload from the canonical benchmark dataset. */
export function httpWorkloadRps(
  runtime: string,
  framework: string,
  workload: HttpWorkloadMetric,
): number | undefined {
  return parseRps(httpWorkloadRow(runtime, framework)?.[workload])
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

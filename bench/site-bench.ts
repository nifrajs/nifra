/**
 * Push fresh benchmark numbers to the website. The landing + /benchmarks read
 * `site/data/benchmarks.json` (a single source of truth); a bench run calls `writeSiteBench(slice)`
 * here to merge its slice in, so the published numbers can't drift from the latest run.
 *
 * Each suite owns whole slices: `bench:http:update` → `http`; `bench:ssr` → `heroSsr`/`frontend`/
 * `multipliers`; `bench:size` → `bundle`. A merge replaces only the slices passed, leaving the rest.
 */

import { join } from "node:path"

export interface BenchRow {
  readonly name: string
  readonly reqs: number
  readonly you?: boolean
}
export interface BundleRow {
  readonly name: string
  readonly kb: number
  readonly you?: boolean
}
export interface Multiplier {
  readonly fw: string
  readonly mult: string
  readonly rival: string
}
export interface ProofStat {
  readonly value: string
  readonly label: string
}
export interface HttpRuntimeRow {
  readonly runtime: string
  readonly reqs: number
  readonly pctOfRaw: number
  readonly you?: boolean
}

export interface HttpWorkloadRow {
  readonly name: string
  readonly getUsers: string
  readonly postUsers: string
  readonly nifra?: boolean
}

export interface HttpWorkloadTable {
  readonly title: string
  readonly rows: readonly HttpWorkloadRow[]
}

/**
 * A realistic-shape row: the same GET/POST split as `HttpWorkloadRow`, plus the body-middleware
 * workload, on a route carrying security headers, CORS, a request-id hook, bearer auth and a cookie
 * read. Kept separate from `httpWorkloads` rather than folded in, because the two answer different
 * questions - the bare tables measure the framework floor (where nifra's fused lane applies), these
 * measure a route shaped like one people deploy (where it does not, for any framework).
 */
export interface HttpRealworldRow {
  readonly name: string
  readonly get: string
  readonly post: string
  readonly body: string
  readonly nifra?: boolean
}

export interface HttpRealworldTable {
  readonly title: string
  readonly rows: readonly HttpRealworldRow[]
}

/** A /benchmarks SSR table row (display-ready; `jsGzKb` = gzipped client JS in KB). */
export interface SsrSiteRow {
  readonly name: string
  readonly runtime: "bun" | "node"
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
  readonly jsGzKb: number
  readonly nifra?: boolean
}

/** A per-framework SSR group on /benchmarks. */
export interface SsrSiteTable {
  readonly framework: string
  readonly rows: readonly SsrSiteRow[]
}

export interface SiteBench {
  readonly _note?: string
  readonly heroSsr: readonly BenchRow[]
  readonly frontend: readonly BenchRow[]
  readonly multipliers: readonly Multiplier[]
  readonly ssrTables?: readonly SsrSiteTable[]
  /** Table B - cacheable modes (SSG/ISR), rendered as separately-labelled tables, never blended into ssrTables. */
  readonly ssrTablesB?: readonly SsrSiteTable[]
  readonly httpRuntime?: readonly HttpRuntimeRow[]
  readonly http: readonly BenchRow[]
  /** Core GET/POST workload comparison used by the benchmarks page and articles. */
  readonly httpWorkloads?: readonly HttpWorkloadTable[]
  /** The same matrix on an auth+middleware route - the shape no framework fast-lanes. */
  readonly httpRealworld?: readonly HttpRealworldTable[]
  readonly bundle: readonly BundleRow[]
  readonly proof: readonly ProofStat[]
}

const SITE_DATA = join(import.meta.dir, "..", "site", "data", "benchmarks.json")

/** Merge a partial set of slices over the current data - pure; only the passed slices change. */
export function mergeSiteBench(current: SiteBench, partial: Partial<SiteBench>): SiteBench {
  return { ...current, ...partial }
}

/** The HTTP slice the landing shows: Node, `GET /users/:id` (routing + path param - the representative
 * read, and in the default core workload set), the framework set it compares on. Pulls each framework's
 * req/s from an aggregate's `results.node`; skips any that didn't run. */
export function httpSliceFromNode(
  node: Record<string, Record<string, { rps: number } | undefined> | undefined> | undefined,
  workload = "GET /users/:id",
): BenchRow[] {
  const DISPLAY: Record<string, string> = {
    nifra: "Nifra",
    fastify: "Fastify",
    express: "Express",
    hono: "Hono",
  }
  const rows: BenchRow[] = []
  for (const [key, label] of Object.entries(DISPLAY)) {
    const rps = node?.[key]?.[workload]?.rps
    if (rps !== undefined && rps > 0)
      rows.push({ name: label, reqs: Math.round(rps), you: key === "nifra" })
  }
  return rows.sort((a, b) => b.reqs - a.reqs)
}

/**
 * The landing's per-runtime slice: nifra's `GET /users/:id` throughput on each runtime, alongside
 * that runtime's own raw-server ceiling as `pctOfRaw`.
 *
 * The percentage is the point. Raw req/s is NOT comparable across runtimes - Bun's, Node's and
 * Deno's servers, HTTP parsers and thread pools differ enough that a cross-runtime absolute says
 * more about the runtime than about nifra. "How much of this runtime's own ceiling does the
 * framework keep" is comparable, and it is what the landing claims.
 *
 * A runtime missing either cell is dropped rather than published at a percentage computed from a
 * hole. Rows are ordered by throughput, matching how the landing renders them.
 */
export function httpRuntimeFromResults(
  results: Record<
    string,
    Record<string, Record<string, { readonly rps: number } | undefined> | undefined> | undefined
  >,
  workload = "GET /users/:id",
): readonly HttpRuntimeRow[] {
  const runtimeConfig: ReadonlyArray<{ key: string; title: string; ceiling: string }> = [
    { key: "bun", title: "Bun", ceiling: "bun-native" },
    { key: "deno", title: "Deno", ceiling: "deno-raw" },
    { key: "node", title: "Node", ceiling: "node-raw" },
  ]
  const ok = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0

  const rows: HttpRuntimeRow[] = []
  for (const runtime of runtimeConfig) {
    const source = results[runtime.key]
    if (source === undefined) continue
    const nifra = source.nifra?.[workload]?.rps
    const raw = source[runtime.ceiling]?.[workload]?.rps
    if (!ok(nifra) || !ok(raw)) continue
    rows.push({
      runtime: runtime.title,
      reqs: Math.round(nifra),
      pctOfRaw: Math.round((nifra / raw) * 100),
      you: true,
    })
  }
  return rows.sort((a, b) => b.reqs - a.reqs)
}

/** Convert the complete core GET/POST matrix to the canonical article/page slice. A partial runtime
 * result omits its table; the aggregate writer only publishes this slice when all runtimes ran. */
export function httpWorkloadsFromResults(
  results: Record<
    string,
    Record<string, Record<string, { readonly rps: number } | undefined> | undefined> | undefined
  >,
): readonly HttpWorkloadTable[] {
  const runtimeConfig: ReadonlyArray<{
    key: string
    title: string
    frameworks: readonly string[]
  }> = [
    { key: "bun", title: "Bun", frameworks: ["nifra", "elysia", "bun-native", "hono"] },
    {
      key: "node",
      title: "Node",
      frameworks: ["nifra", "node-raw", "fastify", "elysia", "express", "hono"],
    },
    { key: "deno", title: "Deno", frameworks: ["deno-raw", "nifra", "elysia", "hono"] },
  ]
  const display: Record<string, string> = {
    nifra: "Nifra",
    elysia: "Elysia",
    "bun-native": "bun-native",
    "node-raw": "node-raw",
    "deno-raw": "deno-raw",
    fastify: "Fastify",
    express: "Express",
    hono: "Hono",
  }
  const format = (rps: number): string => Math.round(rps).toLocaleString("en-US")
  const tables: HttpWorkloadTable[] = []
  for (const runtime of runtimeConfig) {
    const source = results[runtime.key]
    if (source === undefined) continue
    const rows: HttpWorkloadRow[] = []
    for (const framework of runtime.frameworks) {
      const get = source[framework]?.["GET /users/:id"]?.rps
      const post = source[framework]?.["POST /users"]?.rps
      if (
        get === undefined ||
        post === undefined ||
        !Number.isFinite(get) ||
        !Number.isFinite(post) ||
        get < 0 ||
        post < 0
      )
        continue
      rows.push({
        name: display[framework] ?? framework,
        getUsers: format(get),
        postUsers: format(post),
        ...(framework === "nifra" ? { nifra: true } : {}),
      })
    }
    if (rows.length > 0) tables.push({ title: runtime.title, rows })
  }
  return tables
}

/**
 * Convert the realistic-shape matrix to its site slice. The body-middleware workload is served by
 * the `*-body` targets, so a row pulls its third column from the suffixed framework key. A framework
 * missing any of the three cells is dropped rather than published with a hole.
 */
export function httpRealworldFromResults(
  results: Record<
    string,
    Record<string, Record<string, { readonly rps: number } | undefined> | undefined> | undefined
  >,
  workloads: { readonly get: string; readonly post: string; readonly body: string },
): readonly HttpRealworldTable[] {
  const runtimeConfig: ReadonlyArray<{
    key: string
    title: string
    frameworks: readonly string[]
  }> = [
    { key: "bun", title: "Bun", frameworks: ["nifra", "elysia", "bun-native", "hono"] },
    {
      key: "node",
      title: "Node",
      frameworks: ["nifra", "node-raw", "fastify", "elysia", "express", "hono"],
    },
    { key: "deno", title: "Deno", frameworks: ["deno-raw", "nifra", "elysia", "hono"] },
  ]
  const display: Record<string, string> = {
    nifra: "Nifra",
    elysia: "Elysia",
    "bun-native": "bun-native",
    "node-raw": "node-raw",
    "deno-raw": "deno-raw",
    fastify: "Fastify",
    express: "Express",
    hono: "Hono",
  }
  const format = (rps: number): string => Math.round(rps).toLocaleString("en-US")
  const ok = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0

  const tables: HttpRealworldTable[] = []
  for (const runtime of runtimeConfig) {
    const source = results[runtime.key]
    if (source === undefined) continue
    const rows: HttpRealworldRow[] = []
    for (const framework of runtime.frameworks) {
      const get = source[framework]?.[workloads.get]?.rps
      const post = source[framework]?.[workloads.post]?.rps
      const body = source[`${framework}-body`]?.[workloads.body]?.rps
      if (!ok(get) || !ok(post) || !ok(body)) continue
      rows.push({
        name: display[framework] ?? framework,
        get: format(get),
        post: format(post),
        body: format(body),
        ...(framework === "nifra" ? { nifra: true } : {}),
      })
    }
    if (rows.length > 0) tables.push({ title: runtime.title, rows })
  }
  return tables
}

/** Read the site data, merge the slice, write it back (stable 2-space JSON). No-ops on an empty slice. */
export async function writeSiteBench(partial: Partial<SiteBench>): Promise<void> {
  if (Object.keys(partial).length === 0) return
  const current = (await Bun.file(SITE_DATA).json()) as SiteBench
  await Bun.write(SITE_DATA, `${JSON.stringify(mergeSiteBench(current, partial), null, 2)}\n`)
  process.stderr.write(`updated site/data/benchmarks.json (${Object.keys(partial).join(", ")})\n`)
}

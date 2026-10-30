/**
 * Push fresh benchmark numbers to the website. The landing + /benchmarks read
 * `site/shared/data/benchmarks.json` (a single source of truth); a bench run calls `writeSiteBench(slice)`
 * here to merge its slice in, so the published numbers can't drift from the latest run.
 *
 * Each suite writes only the result slices it measured; partial updates leave other published
 * slices intact. The website tables and comparison articles consume this same dataset.
 *
 * Every published row names the version it measured. The raw-runtime and raw-renderer rows the
 * suites measure against stay in the local reports only: on the site a framework row above a "raw"
 * one reads as a measurement error rather than as the ratio it is.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type {
  HttpMemoryCapture,
  HttpMemoryRow,
  HttpMemoryRuntime,
} from "../site/shared/data/memory-types.ts"

export interface BenchRow {
  readonly name: string
  readonly version: string
  readonly reqs: number
  readonly you?: boolean
}
export interface BundleRow {
  readonly name: string
  readonly version: string
  readonly kb: number
  readonly you?: boolean
}
export interface Multiplier {
  readonly fw: string
  readonly mult: string
  readonly rival: string
  readonly rivalVersion: string
}
export interface ProofStat {
  readonly value: string
  readonly label: string
}

/** When and with which toolchain a slice was measured; `deno` is absent for a suite that skips it. */
export interface CapturedMeta {
  readonly date: string
  readonly bun: string
  readonly node: string
  readonly deno?: string
  readonly oha: string
}

export interface HttpWorkloadRow {
  readonly name: string
  readonly version: string
  readonly getUsers: string
  readonly postUsers: string
  readonly nifra?: boolean
}

export interface HttpWorkloadTable {
  readonly title: string
  /** The runtime's version. */
  readonly version: string
  readonly rows: readonly HttpWorkloadRow[]
}

/**
 * A realistic-shape row: the same GET/POST split as `HttpWorkloadRow`, plus the body-middleware
 * workload, on a route carrying security headers, CORS, a request-id hook, bearer auth and a cookie
 * read. Kept separate from `httpWorkloads` rather than folded in, because the two answer different
 * questions - the bare tables measure the framework floor (where nifra's fused lane applies), these
 * measure a route shaped like one people deploy.
 */
export interface HttpRealworldRow {
  readonly name: string
  readonly version: string
  readonly get: string
  readonly post: string
  readonly body: string
  readonly nifra?: boolean
}

export interface HttpRealworldTable {
  readonly title: string
  /** The runtime's version. */
  readonly version: string
  readonly rows: readonly HttpRealworldRow[]
}

/** A /benchmarks SSR table row (display-ready; `jsGzKb` = gzipped client JS in KB). */
export interface SsrSiteRow {
  readonly name: string
  readonly version: string
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
  readonly httpMemory?: Partial<Record<HttpMemoryRuntime, HttpMemoryCapture>>
  readonly _note?: string
  // One record per slice, not one for the file: the suites run at different times, and a shared
  // record would attribute every table to whichever suite wrote last.
  readonly httpWorkloadsCaptured?: CapturedMeta
  readonly httpRealworldCaptured?: CapturedMeta
  readonly ssrCaptured?: CapturedMeta
  readonly heroSsr: readonly BenchRow[]
  readonly frontend: readonly BenchRow[]
  readonly multipliers: readonly Multiplier[]
  readonly ssrTables?: readonly SsrSiteTable[]
  /** Table B - cacheable modes (SSG/ISR), rendered as separately-labelled tables, never blended into ssrTables. */
  readonly ssrTablesB?: readonly SsrSiteTable[]
  readonly http: readonly BenchRow[]
  /** Core GET/POST workload comparison used by the benchmarks page and articles. */
  readonly httpWorkloads?: readonly HttpWorkloadTable[]
  /** The same matrix on an auth+middleware route - the shape no framework fast-lanes. */
  readonly httpRealworld?: readonly HttpRealworldTable[]
  readonly bundle: readonly BundleRow[]
  readonly proof: readonly ProofStat[]
}

export type LegacyNodeHttpMemoryCapture = Omit<HttpMemoryCapture, "runtime" | "runtimeVersion">
export type LegacySiteBench = Omit<SiteBench, "httpMemory"> & {
  readonly httpMemory?: LegacyNodeHttpMemoryCapture
}

const HTTP_MEMORY_RUNTIMES = ["node", "bun", "deno"] as const

// biome-ignore lint/plugin/noHelperCopy: Benchmark publishing validates persisted JSON locally; importing an unrelated package's internal guard would cross package boundaries.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isMemoryRow(value: unknown): value is HttpMemoryRow {
  if (!isRecord(value)) return false
  return (
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    (!("nifra" in value) || typeof value.nifra === "boolean") &&
    typeof value.readyRssMiB === "number" &&
    typeof value.getRssMiB === "number" &&
    typeof value.postRssMiB === "number" &&
    typeof value.postHeapMiB === "number" &&
    typeof value.peakRssMiB === "number" &&
    typeof value.postRssMinMiB === "number" &&
    typeof value.postRssMaxMiB === "number"
  )
}

function isMemoryCaptureBase(value: unknown): value is LegacyNodeHttpMemoryCapture {
  if (!isRecord(value) || !Array.isArray(value.rows) || !value.rows.every(isMemoryRow)) return false
  return (
    typeof value.node === "string" &&
    typeof value.date === "string" &&
    typeof value.platform === "string" &&
    typeof value.cpu === "string" &&
    typeof value.revision === "string" &&
    typeof value.workspaceArtifactSHA256 === "string" &&
    (value.protocol === "fresh-native-node-v1" ||
      value.protocol === "fresh-native-bun-v1" ||
      value.protocol === "fresh-native-deno-v1") &&
    typeof value.rounds === "number" &&
    typeof value.requestsPerPhase === "number" &&
    typeof value.connections === "number"
  )
}

function isLegacyNodeMemoryCapture(value: unknown): value is LegacyNodeHttpMemoryCapture {
  return (
    isMemoryCaptureBase(value) &&
    value.protocol === "fresh-native-node-v1" &&
    !("runtime" in value) &&
    !("runtimeVersion" in value)
  )
}

function isHttpMemoryRuntime(value: string): value is HttpMemoryRuntime {
  return HTTP_MEMORY_RUNTIMES.some((runtime) => runtime === value)
}

function isHttpMemoryCapture(
  value: unknown,
  runtime: HttpMemoryRuntime,
): value is HttpMemoryCapture {
  const expectedProtocol =
    runtime === "node"
      ? "fresh-native-node-v1"
      : runtime === "bun"
        ? "fresh-native-bun-v1"
        : "fresh-native-deno-v1"
  return (
    isMemoryCaptureBase(value) &&
    "runtime" in value &&
    value.runtime === runtime &&
    "runtimeVersion" in value &&
    typeof value.runtimeVersion === "string" &&
    value.protocol === expectedProtocol
  )
}

function normalizeHttpMemory(
  value: unknown,
): Partial<Record<HttpMemoryRuntime, HttpMemoryCapture>> {
  if (value === undefined || value === null) return {}
  if (isLegacyNodeMemoryCapture(value)) {
    return { node: { ...value, runtime: "node", runtimeVersion: value.node } }
  }
  if (!isRecord(value)) throw new Error("invalid HTTP memory capture map")

  const captures: Partial<Record<HttpMemoryRuntime, HttpMemoryCapture>> = {}
  for (const [runtime, candidate] of Object.entries(value)) {
    if (!isHttpMemoryRuntime(runtime) || !isHttpMemoryCapture(candidate, runtime)) {
      throw new Error(`invalid HTTP memory capture for ${runtime}`)
    }
    captures[runtime] = candidate
  }
  return captures
}

const SITE_DATA = join(import.meta.dir, "..", "site", "shared", "data", "benchmarks.json")

function manifestVersion(path: string): string {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  )
    return manifest.version
  throw new Error(`${path} names no version`)
}

/**
 * The installed version of `name`, found the way Node resolves it: the nearest `node_modules` at or
 * above `from`. A row without a version is never published, so a package that cannot be found throws.
 */
export function packageVersion(name: string, from: string = import.meta.dir): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json")
    if (existsSync(manifest)) return manifestVersion(manifest)
    if (dirname(dir) === dir) throw new Error(`no installed ${name} at or above ${from}`)
  }
}

/** The nifra version under benchmark: the workspace's own core package, not an installed copy. */
export const NIFRA_VERSION = manifestVersion(
  join(import.meta.dir, "..", "packages", "core", "package.json"),
)

/** The package each HTTP framework key measures; nifra is the workspace build. */
const HTTP_PACKAGES: Readonly<Record<string, string>> = {
  elysia: "elysia",
  fastify: "fastify",
  express: "express",
  hono: "hono",
}

/** The version a published HTTP row carries. */
export function httpFrameworkVersion(framework: string): string {
  if (framework === "nifra") return NIFRA_VERSION
  const pkg = HTTP_PACKAGES[framework]
  if (pkg === undefined) throw new Error(`no package recorded for HTTP framework ${framework}`)
  return packageVersion(pkg)
}

/** The runtime versions an HTTP matrix ran on, keyed like its results. */
export interface RuntimeVersions {
  readonly bun: string
  readonly node: string
  readonly deno: string
}

/** The capture record for a run on `versions`, dated today (UTC). */
export function capturedMeta(versions: {
  readonly bun: string
  readonly node: string
  readonly deno?: string
  readonly oha: string
}): CapturedMeta {
  const bare = (version: string): string => version.trim().replace(/^v/, "")
  const captured: CapturedMeta = {
    date: new Date().toISOString().slice(0, 10),
    bun: bare(versions.bun),
    node: bare(versions.node),
    oha: bare(versions.oha),
  }
  return versions.deno === undefined ? captured : { ...captured, deno: bare(versions.deno) }
}

/** The installed `oha`'s version; a published slice names it, so a missing `oha` throws. */
export function ohaVersion(): string {
  const result = Bun.spawnSync(["oha", "--version"])
  const version = /\d+(?:\.\d+)+/.exec(new TextDecoder().decode(result.stdout))?.[0]
  if (!result.success || version === undefined) throw new Error("oha --version gave no version")
  return version
}

/** Merge a partial set of slices over the current data - pure; only the passed slices change. */
/** Merge a partial set of slices over the current data - pure; only the passed slices change. */
export function mergeSiteBench(
  current: SiteBench | LegacySiteBench,
  partial: Partial<SiteBench>,
): SiteBench {
  const { httpMemory: currentMemory, ...currentWithoutMemory } = current
  const { httpMemory: partialMemory, ...partialWithoutMemory } = partial
  const merged = { ...currentWithoutMemory, ...partialWithoutMemory }

  if (currentMemory === undefined && partialMemory === undefined) return merged
  return {
    ...merged,
    httpMemory: {
      ...normalizeHttpMemory(currentMemory),
      ...normalizeHttpMemory(partialMemory),
    },
  }
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
      rows.push({
        name: label,
        version: httpFrameworkVersion(key),
        reqs: Math.round(rps),
        you: key === "nifra",
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
  runtimeVersions: RuntimeVersions,
): readonly HttpWorkloadTable[] {
  const runtimeConfig: ReadonlyArray<{
    key: keyof RuntimeVersions
    title: string
    frameworks: readonly string[]
  }> = [
    { key: "bun", title: "Bun", frameworks: ["nifra", "elysia", "hono"] },
    { key: "node", title: "Node", frameworks: ["nifra", "fastify", "elysia", "express", "hono"] },
    { key: "deno", title: "Deno", frameworks: ["nifra", "elysia", "hono"] },
  ]
  const display: Record<string, string> = {
    nifra: "Nifra",
    elysia: "Elysia",
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
        version: httpFrameworkVersion(framework),
        getUsers: format(get),
        postUsers: format(post),
        ...(framework === "nifra" ? { nifra: true } : {}),
      })
    }
    if (rows.length > 0)
      tables.push({
        title: runtime.title,
        version: runtimeVersions[runtime.key].replace(/^v/, ""),
        rows,
      })
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
  runtimeVersions: RuntimeVersions,
): readonly HttpRealworldTable[] {
  const runtimeConfig: ReadonlyArray<{
    key: keyof RuntimeVersions
    title: string
    frameworks: readonly string[]
  }> = [
    { key: "bun", title: "Bun", frameworks: ["nifra", "elysia", "hono"] },
    { key: "node", title: "Node", frameworks: ["nifra", "fastify", "elysia", "express", "hono"] },
    { key: "deno", title: "Deno", frameworks: ["nifra", "elysia", "hono"] },
  ]
  const display: Record<string, string> = {
    nifra: "Nifra",
    elysia: "Elysia",
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
        version: httpFrameworkVersion(framework),
        get: format(get),
        post: format(post),
        body: format(body),
        ...(framework === "nifra" ? { nifra: true } : {}),
      })
    }
    if (rows.length > 0)
      tables.push({
        title: runtime.title,
        version: runtimeVersions[runtime.key].replace(/^v/, ""),
        rows,
      })
  }
  return tables
}

/** Read the site data, merge the slice, write it back (stable 2-space JSON). No-ops on an empty slice. */
export async function writeSiteBench(partial: Partial<SiteBench>): Promise<void> {
  if (Object.keys(partial).length === 0) return
  const current: SiteBench | LegacySiteBench = await Bun.file(SITE_DATA).json()
  await Bun.write(SITE_DATA, `${JSON.stringify(mergeSiteBench(current, partial), null, 2)}\n`)
  process.stderr.write(
    `updated site/shared/data/benchmarks.json (${Object.keys(partial).join(", ")})\n`,
  )
}

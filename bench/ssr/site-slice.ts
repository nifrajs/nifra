/**
 * Turn a finished SSR run into the website's benchmark slices. `run.ts` collects each table's
 * results and hands them here; the builders are pure so they can be unit-tested without running
 * oha. Table A (uncached SSR) and Table B (SSG/ISR) are emitted as SEPARATE slices and rendered
 * as separately-labelled tables - never blended into one, which is exactly the apples-to-oranges
 * read bench/ssr/README.md warns against. The landing bar chart and multipliers stay Table A only.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isJsonRecord } from "../../scripts/read-json.ts"
import { type BenchRow, type Multiplier, NIFRA_VERSION } from "../site-bench.ts"
import { pairedRatio, rowKind, type SsrBenchResult, type SsrBenchTarget } from "./harness.ts"

/** One measured Table A row: the target it ran plus the framework section it ran under. */
export interface SsrRunRow {
  readonly framework: string
  readonly target: SsrBenchTarget
  readonly result: SsrBenchResult
  readonly samples?: readonly number[]
}

/** A /benchmarks table row - display-ready, one per target. */
export interface SsrTableRow {
  readonly name: string
  readonly version: string
  readonly runtime: "bun" | "node"
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
  /** Gzipped client JS the SSR page ships, in KB (0 when the run couldn't account it). */
  readonly jsGzKb: number
  readonly nifra?: boolean
}

/** A per-framework group on /benchmarks - the separation the flat table lacked. */
export interface SsrTable {
  readonly framework: string
  readonly rows: readonly SsrTableRow[]
}

/** The website display name for a bench target name. */
const DISPLAY: Record<string, string> = {
  "next (dynamic)": "Next.js (Node)",
  // The Remix row runs React Router's framework mode, so the version it carries is React Router's.
  remix: "Remix / React Router (Node)",
  solidstart: "SolidStart (Node)",
  nuxt: "Nuxt (Node)",
  sveltekit: "SvelteKit (Node)",
  // Table B - cacheable modes, labelled explicitly so a cached row can never read as SSR.
  "next (static)": "Next.js static (Node)",
  "next (ISR)": "Next.js ISR (Node)",
  "solidstart (static)": "SolidStart static (Node)",
  "nuxt (static)": "Nuxt static (Node)",
  "sveltekit (static)": "SvelteKit static (Node)",
  // The one raw row the site shows: Preact has no meta-framework on Node to compare with.
  "preact-ssr": "Raw Preact render (Node, ceiling)",
}

/** The version a published row carries, by target; the run passes `ssrTargetVersion`. */
export type SsrVersionOf = (target: SsrBenchTarget) => string

/** Versions captured by the run that actually built and measured the target. */
export type SsrTargetVersionMap = Readonly<Record<string, string>>

/** The package each rival app measures, by bench target name prefix. */
const RIVAL_PACKAGES: ReadonlyArray<readonly [prefix: string, pkg: string]> = [
  ["next", "next"],
  ["remix", "react-router"],
  ["solidstart", "@solidjs/start"],
  ["nuxt", "nuxt"],
  ["sveltekit", "@sveltejs/kit"],
  ["preact-ssr", "preact-render-to-string"],
]

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function stringMap(value: unknown): Record<string, string> {
  if (!isJsonRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

function manifestDeps(cwd: string): Record<string, string> {
  const manifest: unknown = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
  if (!isJsonRecord(manifest)) {
    throw new Error(`${cwd}/package.json is not an object`)
  }
  return {
    ...stringMap(manifest.dependencies),
    ...stringMap(manifest.devDependencies),
    ...stringMap(manifest.overrides),
  }
}

/** The exact version `cwd` declares for `pkg`. A range is refused: the row would not name one install. */
export function declaredExactVersion(cwd: string, pkg: string): string {
  const spec = manifestDeps(cwd)[pkg]
  if (spec === undefined) throw new Error(`${cwd} does not depend on ${pkg}`)
  if (!EXACT_VERSION.test(spec)) {
    throw new Error(`${pkg} in ${cwd} must be an exact version, found ${JSON.stringify(spec)}`)
  }
  return spec
}

function installedVersion(cwd: string, pkg: string, declared: string): string {
  const manifest = join(cwd, "node_modules", pkg, "package.json")
  if (!existsSync(manifest)) {
    throw new Error(`${pkg} is not installed in ${cwd}. The bench install has not run there.`)
  }
  const installedManifest: unknown = JSON.parse(readFileSync(manifest, "utf8"))
  const installed =
    typeof installedManifest === "object" &&
    installedManifest !== null &&
    "version" in installedManifest &&
    typeof installedManifest.version === "string"
      ? installedManifest.version
      : undefined
  if (installed !== declared) {
    throw new Error(
      `${pkg} in ${cwd} declares ${declared} but ${cwd}/node_modules has ${String(installed)}`,
    )
  }
  return installed
}

/** Every direct benchmark dependency must be the exact install the app declared. */
function assertInstalledDependencies(cwd: string): void {
  for (const pkg of Object.keys(manifestDeps(cwd))) {
    const declared = declaredExactVersion(cwd, pkg)
    installedVersion(cwd, pkg, declared)
  }
}

/**
 * nifra rows carry the workspace version. A rival row carries the version installed in that app,
 * which has to be the exact pin in its package.json. Walking up to some other node_modules would
 * label a package this app did not run.
 */
export function ssrTargetVersion(target: SsrBenchTarget): string {
  if (target.name.startsWith("nifra")) return NIFRA_VERSION
  const pkg = RIVAL_PACKAGES.find(([prefix]) => target.name.startsWith(prefix))?.[1]
  if (pkg === undefined || target.cwd === undefined) {
    throw new Error(`no package recorded for SSR target ${target.name}`)
  }
  assertInstalledDependencies(target.cwd)
  const declared = declaredExactVersion(target.cwd, pkg)
  return installedVersion(target.cwd, pkg, declared)
}

/** Resolve every target in one run once, so site rows cannot be labelled by a later install. */
export function ssrTargetVersionMap(targets: readonly SsrBenchTarget[]): SsrTargetVersionMap {
  const versions: Record<string, string> = {}
  for (const target of targets) {
    if (versions[target.name] !== undefined) {
      throw new Error(`duplicate SSR target name ${target.name}`)
    }
    versions[target.name] = ssrTargetVersion(target)
  }
  return versions
}

/** Turn a captured version map into the callback consumed by the site-slice builders. */
export function ssrVersionOfMap(versions: SsrTargetVersionMap): SsrVersionOf {
  return (target) => {
    const version = versions[target.name]
    if (version === undefined) {
      throw new Error(`SSR target version map has no entry for ${target.name}`)
    }
    return version
  }
}

/** nifra Table B rows carry their mode in the bench name ("nifra+react (SSG)" / "(ISR)"). */
const NIFRA_MODE = /\((SSG|ISR)(?:, node)?\)$/

/** The rival each framework's multiplier compares nifra's NODE row against (same-runtime, fair). */
const RIVAL: Record<string, { target: string; label: string }> = {
  React: { target: "next (dynamic)", label: "Next.js" },
  Solid: { target: "solidstart", label: "SolidStart" },
  Vue: { target: "nuxt", label: "Nuxt" },
  Svelte: { target: "sveltekit", label: "SvelteKit" },
}

function displayName(row: SsrRunRow): string {
  return ssrRowName(row.framework, row.target)
}

/** The website name of `target` measured under the `framework` section. */
export function ssrRowName(fw: string, target: SsrBenchTarget): string {
  const mapped = DISPLAY[target.name]
  if (mapped !== undefined) return mapped
  const runtime = target.runtime === "node" ? "Node" : "Bun"
  if (rowKind(target) === "static-host") return `Nifra + ${fw} SSG files on a static host`
  // nifra Table B rows: "nifra+react (SSG)" → "Nifra + React SSG (Bun)"
  const mode = NIFRA_MODE.exec(target.name)
  if (mode !== null) return `Nifra + ${fw} ${mode[1]} (${runtime})`
  // nifra rows: "nifra+react" → "Nifra + React (Bun)", "nifra+react (node)" → "Nifra + React (Node)"
  return `Nifra + ${fw} (${runtime})`
}

function isNifra(row: SsrRunRow): boolean {
  return row.target.name.startsWith("nifra")
}

function toTableRow(row: SsrRunRow, versionOf: SsrVersionOf): SsrTableRow {
  return {
    name: displayName(row),
    version: versionOf(row.target),
    runtime: row.target.runtime,
    rps: row.result.rps,
    p50ms: Math.round(row.result.p50ms * 100) / 100,
    p99ms: Math.round(row.result.p99ms * 100) / 100,
    jsGzKb: Math.round((row.result.payloadGzip / 1024) * 10) / 10,
    ...(isNifra(row) ? { nifra: true } : {}),
  }
}

/** Group Table A rows per framework, in run order - the /benchmarks `ssrTables` slice. */
export function ssrTablesSlice(
  rows: readonly SsrRunRow[],
  versionOf: SsrVersionOf,
): readonly SsrTable[] {
  const order: string[] = []
  const byFw = new Map<string, SsrTableRow[]>()
  for (const row of rows) {
    let group = byFw.get(row.framework)
    if (group === undefined) {
      group = []
      byFw.set(row.framework, group)
      order.push(row.framework)
    }
    group.push(toTableRow(row, versionOf))
  }
  return order.map((framework) => ({ framework, rows: byFw.get(framework) ?? [] }))
}

/** Rows that compare a framework app with a framework app; a raw renderer row never headlines. */
function likeForLike(row: SsrRunRow): boolean {
  return rowKind(row.target) === "app"
}

/**
 * The landing bar chart compares Node SSR apps on one runner. Keep Bun's standalone Nifra result in
 * the full tables, where it is labeled by runtime, but don't rank it beside Node rows from a
 * separate runner whose CPU model may differ.
 */
export function heroSsrSlice(
  rows: readonly SsrRunRow[],
  versionOf: SsrVersionOf,
): readonly BenchRow[] {
  return rows
    .filter((r) => r.framework === "React" && likeForLike(r) && r.target.runtime === "node")
    .map((r) => ({
      name: displayName(r),
      version: versionOf(r.target),
      reqs: r.result.rps,
      ...(isNifra(r) ? { you: true } : {}),
    }))
}

/** Every Table A row as a flat bar list (grouped by framework order) - the `frontend` slice. */
export function frontendSlice(
  rows: readonly SsrRunRow[],
  versionOf: SsrVersionOf,
): readonly BenchRow[] {
  return rows.filter(likeForLike).map((r) => ({
    name: displayName(r),
    version: versionOf(r.target),
    reqs: r.result.rps,
    ...(isNifra(r) ? { you: true } : {}),
  }))
}

/** "N×" with one decimal under 10 ("3.8×"), integers above ("26×"); trailing .0 dropped. */
export function formatMultiplier(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "1×"
  if (ratio >= 10) return `${Math.round(ratio)}×`
  const oneDecimal = Math.round(ratio * 10) / 10
  return Number.isInteger(oneDecimal) ? `${oneDecimal}×` : `${oneDecimal.toFixed(1)}×`
}

/** Same-runtime headline ratios: nifra's NODE row vs each framework's meta-framework on Node. */
export function multipliersSlice(
  rows: readonly SsrRunRow[],
  versionOf: SsrVersionOf,
): readonly Multiplier[] {
  const out: Multiplier[] = []
  for (const [fw, rival] of Object.entries(RIVAL)) {
    const nifraNode = rows.find(
      (r) => r.framework === fw && isNifra(r) && likeForLike(r) && r.target.runtime === "node",
    )
    const rivalRow = rows.find((r) => r.target.name === rival.target)
    if (nifraNode === undefined || rivalRow === undefined || rivalRow.result.rps === 0) continue
    out.push({
      fw,
      mult: formatMultiplier(
        nifraNode.samples !== undefined && rivalRow.samples !== undefined
          ? pairedRatio(nifraNode.samples, rivalRow.samples)
          : nifraNode.result.rps / rivalRow.result.rps,
      ),
      rival: rival.label,
      rivalVersion: versionOf(rivalRow.target),
    })
  }
  return out
}

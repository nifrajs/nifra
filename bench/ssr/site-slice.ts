/**
 * Turn a finished SSR run into the website's benchmark slices. `run.ts` collects each table's
 * results and hands them here; the builders are pure so they can be unit-tested without running
 * oha. Table A (uncached SSR) and Table B (SSG/ISR) are emitted as SEPARATE slices and rendered
 * as separately-labelled tables - never blended into one, which is exactly the apples-to-oranges
 * read bench/ssr/README.md warns against. The landing bar chart and multipliers stay Table A only.
 */
import { type BenchRow, type Multiplier, NIFRA_VERSION, packageVersion } from "../site-bench.ts"
import { rowKind, type SsrBenchResult, type SsrBenchTarget } from "./harness.ts"

/** One measured Table A row: the target it ran plus the framework section it ran under. */
export interface SsrRunRow {
  readonly framework: string
  readonly target: SsrBenchTarget
  readonly result: SsrBenchResult
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
}

/** Renderer ceilings: the local report keeps them as a reference, the site never shows them. */
const CEILINGS: ReadonlySet<string> = new Set(["preact-ssr"])

function published(rows: readonly SsrRunRow[]): readonly SsrRunRow[] {
  return rows.filter((row) => !CEILINGS.has(row.target.name))
}

/** The version a published row carries, by target; the run passes `ssrTargetVersion`. */
export type SsrVersionOf = (target: SsrBenchTarget) => string

/** The package each rival app measures, by bench target name prefix. */
const RIVAL_PACKAGES: ReadonlyArray<readonly [prefix: string, pkg: string]> = [
  ["next", "next"],
  ["remix", "react-router"],
  ["solidstart", "@solidjs/start"],
  ["nuxt", "nuxt"],
  ["sveltekit", "@sveltejs/kit"],
]

/** nifra rows carry the workspace version; a rival row the version installed in its own app. */
export function ssrTargetVersion(target: SsrBenchTarget): string {
  if (target.name.startsWith("nifra")) return NIFRA_VERSION
  const pkg = RIVAL_PACKAGES.find(([prefix]) => target.name.startsWith(prefix))?.[1]
  if (pkg === undefined || target.cwd === undefined) {
    throw new Error(`no package recorded for SSR target ${target.name}`)
  }
  return packageVersion(pkg, target.cwd)
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
  // Spelled out so neither row can be read as an app served like the meta-frameworks are.
  if (rowKind(target) === "own-server") {
    return `Nifra + ${fw} render API in your own server (${runtime})`
  }
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
  for (const row of published(rows)) {
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

/** Rows that compare a framework app with a framework app; the own-server rows never headline. */
function likeForLike(row: SsrRunRow): boolean {
  return rowKind(row.target) === "app"
}

/** The landing bar chart: the React story (Bun + Node vs Next + Remix) - the `heroSsr` slice. */
export function heroSsrSlice(
  rows: readonly SsrRunRow[],
  versionOf: SsrVersionOf,
): readonly BenchRow[] {
  return published(rows)
    .filter((r) => r.framework === "React" && likeForLike(r))
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
  return published(rows)
    .filter(likeForLike)
    .map((r) => ({
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
      mult: formatMultiplier(nifraNode.result.rps / rivalRow.result.rps),
      rival: rival.label,
      rivalVersion: versionOf(rivalRow.target),
    })
  }
  return out
}

/**
 * Turn a finished SSR run into the website's benchmark slices. `run.ts` collects each table's
 * results and hands them here; the builders are pure so they can be unit-tested without running
 * oha. Table A (uncached SSR) and Table B (SSG/ISR) are emitted as SEPARATE slices and rendered
 * as separately-labelled tables - never blended into one, which is exactly the apples-to-oranges
 * read SSR-BENCHMARKS.md warns against. The landing bar chart and multipliers stay Table A only.
 */
import type { BenchRow, Multiplier } from "../site-bench.ts"
import type { SsrBenchResult, SsrBenchTarget } from "./harness.ts"

/** One measured Table A row: the target it ran plus the framework section it ran under. */
export interface SsrRunRow {
  readonly framework: string
  readonly target: SsrBenchTarget
  readonly result: SsrBenchResult
}

/** A /benchmarks table row - display-ready, one per target. */
export interface SsrTableRow {
  readonly name: string
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
  remix: "Remix (Node)",
  solidstart: "SolidStart (Node)",
  nuxt: "Nuxt (Node)",
  sveltekit: "SvelteKit (Node)",
  // Table B - cacheable modes, labelled explicitly so a cached row can never read as SSR.
  "next (static)": "Next.js static (Node)",
  "next (ISR)": "Next.js ISR (Node)",
  "solidstart (static)": "SolidStart static (Node)",
  "nuxt (static)": "Nuxt static (Node)",
  "sveltekit (static)": "SvelteKit static (Node)",
  // Renderer ceiling - a hand-rolled single-route server, no framework. Labelled so a reader can
  // see how close the framework rows run to the physical limit of the renderer itself.
  "preact-ssr": "Raw Preact render (Node, ceiling)",
}

/** nifra Table B rows carry their mode in the bench name ("nifra+react (SSG)" / "(ISR)"). */
const NIFRA_MODE = /\((SSG|ISR)\)$/

/** The rival each framework's multiplier compares nifra's NODE row against (same-runtime, fair). */
const RIVAL: Record<string, { target: string; label: string }> = {
  React: { target: "next (dynamic)", label: "Next.js" },
  Solid: { target: "solidstart", label: "SolidStart" },
  Vue: { target: "nuxt", label: "Nuxt" },
  Svelte: { target: "sveltekit", label: "SvelteKit" },
}

function displayName(row: SsrRunRow): string {
  const mapped = DISPLAY[row.target.name]
  if (mapped !== undefined) return mapped
  const fw = row.framework
  // nifra Table B rows: "nifra+react (SSG)" → "Nifra + React SSG (Bun)"
  const mode = NIFRA_MODE.exec(row.target.name)
  if (mode !== null) {
    return row.target.runtime === "node"
      ? `Nifra + ${fw} ${mode[1]} (Node)`
      : `Nifra + ${fw} ${mode[1]} (Bun)`
  }
  // nifra rows: "nifra+react" → "Nifra + React (Bun)", "nifra+react (node)" → "Nifra + React (Node)"
  return row.target.runtime === "node" ? `Nifra + ${fw} (Node)` : `Nifra + ${fw} (Bun)`
}

function isNifra(row: SsrRunRow): boolean {
  return row.target.name.startsWith("nifra")
}

function toTableRow(row: SsrRunRow): SsrTableRow {
  return {
    name: displayName(row),
    runtime: row.target.runtime,
    rps: row.result.rps,
    p50ms: Math.round(row.result.p50ms * 100) / 100,
    p99ms: Math.round(row.result.p99ms * 100) / 100,
    jsGzKb: Math.round((row.result.payloadGzip / 1024) * 10) / 10,
    ...(isNifra(row) ? { nifra: true } : {}),
  }
}

/** Group Table A rows per framework, in run order - the /benchmarks `ssrTables` slice. */
export function ssrTablesSlice(rows: readonly SsrRunRow[]): readonly SsrTable[] {
  const order: string[] = []
  const byFw = new Map<string, SsrTableRow[]>()
  for (const row of rows) {
    let group = byFw.get(row.framework)
    if (group === undefined) {
      group = []
      byFw.set(row.framework, group)
      order.push(row.framework)
    }
    group.push(toTableRow(row))
  }
  return order.map((framework) => ({ framework, rows: byFw.get(framework) ?? [] }))
}

/** The landing bar chart: the React story (Bun + Node vs Next + Remix) - the `heroSsr` slice. */
export function heroSsrSlice(rows: readonly SsrRunRow[]): readonly BenchRow[] {
  return rows
    .filter((r) => r.framework === "React")
    .map((r) => ({
      name: displayName(r),
      reqs: r.result.rps,
      ...(isNifra(r) ? { you: true } : {}),
    }))
}

/** Every Table A row as a flat bar list (grouped by framework order) - the `frontend` slice. */
export function frontendSlice(rows: readonly SsrRunRow[]): readonly BenchRow[] {
  return rows.map((r) => ({
    name: displayName(r),
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
export function multipliersSlice(rows: readonly SsrRunRow[]): readonly Multiplier[] {
  const out: Multiplier[] = []
  for (const [fw, rival] of Object.entries(RIVAL)) {
    const nifraNode = rows.find(
      (r) => r.framework === fw && isNifra(r) && r.target.runtime === "node",
    )
    const rivalRow = rows.find((r) => r.target.name === rival.target)
    if (nifraNode === undefined || rivalRow === undefined || rivalRow.result.rps === 0) continue
    out.push({
      fw,
      mult: formatMultiplier(nifraNode.result.rps / rivalRow.result.rps),
      rival: rival.label,
    })
  }
  return out
}

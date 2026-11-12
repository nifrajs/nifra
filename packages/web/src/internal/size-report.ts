import { codeUnitOrder } from "./code-unit-order.ts"

// ---------------------------------------------------------------------------------------------------
// Bundle-size report (`nifra build --report`). The raw byte + gzip size of each emitted chunk lets a
// dev catch a bundle regression at build time. Pure aggregation/formatting helpers (no fs, no Bun
// build) so they're unit-testable in isolation; the orchestrator below wires them to real outputs.
// ---------------------------------------------------------------------------------------------------

/** One emitted chunk's measured size, in raw bytes + gzipped bytes (over-the-wire weight). */
export interface ChunkSize {
  /** The emitted file's basename (e.g. `index-abc123.js`). */
  readonly name: string
  /** Raw byte length of the file. */
  readonly bytes: number
  /** Gzipped byte length (what the client actually downloads, modulo brotli). */
  readonly gzip: number
}

/** A whole build's size report - every chunk (largest first) + the totals. */
export interface SizeReport {
  /** Per-chunk sizes, sorted biggest gzip first (the regression you want to see at the top). */
  readonly chunks: readonly ChunkSize[]
  /** Sum of every chunk's raw bytes. */
  readonly totalBytes: number
  /** Sum of every chunk's gzip bytes. */
  readonly totalGzip: number
}

/**
 * Aggregate a list of measured chunks into a {@link SizeReport}: sort biggest-gzip-first (ties broken
 * by raw bytes, then name for stable output) and sum the totals. Pure - the measurement (reading the
 * file + gzipping it) happens in the orchestrator; this is the deterministic, unit-testable core.
 */
export function aggregateSizeReport(chunks: readonly ChunkSize[]): SizeReport {
  const sorted = [...chunks].sort(
    (a, b) => b.gzip - a.gzip || b.bytes - a.bytes || codeUnitOrder(a.name, b.name),
  )
  let totalBytes = 0
  let totalGzip = 0
  for (const chunk of sorted) {
    totalBytes += chunk.bytes
    totalGzip += chunk.gzip
  }
  return { chunks: sorted, totalBytes, totalGzip }
}

/** Human-readable byte count: `B`/`KB`/`MB` with one decimal above 1 KB (e.g. `12.3 KB`). Pure. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Render a {@link SizeReport} as a terse aligned table (biggest first) with a totals row - the text
 * `nifra build --report` prints. Pure (string in, string out) so the formatting is unit-testable.
 */
export function renderSizeReport(report: SizeReport): string {
  const rows = report.chunks.map((chunk) => ({
    name: chunk.name,
    raw: formatBytes(chunk.bytes),
    gz: formatBytes(chunk.gzip),
  }))
  // Column widths from the header + every row + the totals label, so the table never clips a value.
  const nameW = Math.max(5, ...rows.map((row) => row.name.length), "Total".length)
  const rawW = Math.max(
    3,
    ...rows.map((row) => row.raw.length),
    formatBytes(report.totalBytes).length,
  )
  const gzW = Math.max(4, ...rows.map((row) => row.gz.length), formatBytes(report.totalGzip).length)
  const padEnd = (value: string, width: number): string =>
    value + " ".repeat(Math.max(0, width - value.length))
  const padStart = (value: string, width: number): string =>
    " ".repeat(Math.max(0, width - value.length)) + value
  const line = (name: string, raw: string, gzip: string): string =>
    `  ${padEnd(name, nameW)}  ${padStart(raw, rawW)}  ${padStart(gzip, gzW)}`
  return [
    line("Chunk", "Raw", "Gzip"),
    line("-".repeat(nameW), "-".repeat(rawW), "-".repeat(gzW)),
    ...rows.map((row) => line(row.name, row.raw, row.gz)),
    line("Total", formatBytes(report.totalBytes), formatBytes(report.totalGzip)),
  ].join("\n")
}

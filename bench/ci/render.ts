/** Markdown for the GitHub job summary: one section per suite x runtime job, and a headline table. */
import { type CiReport, summarize, unsettledRows, type WorkloadSummary } from "./report.ts"
import type { MedianInterval } from "./stats.ts"

const pct = (x: number): number => Math.round(x * 100)

/** "12,345": a median req/s, whole. */
export const formatRps = (rps: number | undefined): string =>
  rps === undefined ? "-" : Math.round(rps).toLocaleString("en-US")

/** "101 (98-103)": the median and its interval, in percent. */
export function formatInterval(i: MedianInterval | undefined, unit = ""): string {
  if (i === undefined) return "-"
  return `${pct(i.median)}${unit} (${pct(i.lo)}-${pct(i.hi)})`
}

function stealNote(steal: readonly (number | null)[]): string | undefined {
  const known = steal.filter((s) => s !== null)
  if (known.length === 0) return undefined
  return `CPU steal up to ${(Math.max(...known) * 100).toFixed(1)}%`
}

function contextLine(report: CiReport): string {
  const { host, runs } = report
  const first = runs[0]?.meta
  const rounds = typeof first?.rounds === "number" ? first.rounds : undefined
  const parts = [
    `${runs.length} runs x ${rounds ?? "?"} rounds`,
    host.cpuModel ?? "CPU model unknown",
    host.split === null
      ? `${host.cpus} CPUs, unpinned`
      : `${host.cpus} CPUs on ${host.split.cores} cores, servers on ${host.split.server.join(",")} and oha on ${host.split.load.join(",")}`,
  ]
  const steal = stealNote(host.steal)
  if (steal !== undefined) parts.push(steal)
  if (first !== undefined) {
    const versions = ["bun", "node", "deno", "oha"].flatMap((tool) => {
      const v = first[tool]
      return v === undefined ? [] : [`${tool} ${v}`]
    })
    parts.push(versions.join(", "))
  }
  return parts.join(" - ")
}

function workloadTable(w: WorkloadSummary): string {
  const lines = [
    `**${w.workload}** (ceiling: ${w.ceiling ?? "none"})`,
    "",
    "| row | req/s | % of ceiling | nifra vs row | verdict |",
    "| --- | ---: | ---: | ---: | --- |",
  ]
  for (const r of w.rows) {
    const cells = [
      r.row,
      formatRps(r.rps),
      formatInterval(r.ofCeiling),
      formatInterval(r.nifraOver, "%"),
      r.verdict,
    ]
    const shown =
      r.row === w.nifra ? cells.map((c, i) => (i < 4 && c !== "-" ? `**${c}**` : c)) : cells
    lines.push(`| ${shown.join(" | ")} |`)
  }
  return lines.join("\n")
}

export function renderSection(report: CiReport): string {
  const workloads = summarize(report.runs, report.runtime, report.settings.maxCiWidthPts)
  const unsettled = unsettledRows(workloads)
  const parts = [`### ${report.suite} - ${report.runtime}`, "", contextLine(report), ""]
  if (report.suite === "ssr") {
    parts.push(
      `nifra runs on ${report.runtime}; the rival apps run on node in both ssr jobs (bench/ssr/README.md).`,
      "",
    )
  }
  if (unsettled > 0) {
    parts.push(
      `${unsettled} row(s) still noisy after ${report.runs.length} of at most ${report.settings.maxRuns} runs; their numbers are listed but are not comparable.`,
      "",
    )
  }
  for (const w of workloads) parts.push(workloadTable(w), "")
  return parts.join("\n")
}

export function renderHeadline(reports: readonly CiReport[]): string {
  const lines = [
    "| suite | runtime | workload | nifra req/s | nifra % of ceiling | rival req/s | nifra vs rival | unsettled rows |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ]
  for (const report of reports) {
    const workloads = summarize(report.runs, report.runtime, report.settings.maxCiWidthPts)
    for (const w of workloads) {
      const nifra = w.rows.find((r) => r.row === w.nifra)
      const rival = w.rows.find((r) => r.row === w.rival)
      // A rival that is also the ceiling has no row-vs-nifra interval; nifra's own % of it is the same ratio.
      const over = rival?.row === w.ceiling ? nifra?.ofCeiling : rival?.nifraOver
      const vsRival = rival === undefined ? "-" : `${formatInterval(over, "%")} vs ${rival.row}`
      const unsettled = w.rows.filter((r) => r.verdict !== "ok").length
      lines.push(
        `| ${report.suite} | ${report.runtime} | ${w.workload} | ${formatRps(nifra?.rps)} | ${formatInterval(nifra?.ofCeiling)} | ${formatRps(rival?.rps)} | ${vsRival} | ${unsettled} |`,
      )
    }
  }
  return lines.join("\n")
}

export function renderFootnote(maxCiWidthPts: number): string {
  return [
    "Every number is the median of per-round ratios measured inside one job, with its 95% interval in brackets",
    "(distribution-free, from order statistics). % of ceiling divides a row by its workload's ceiling in the same",
    "round: the runtime's raw server for http and realworld, the table's baseline row for ssr (the divisor of",
    "bench:ssr's ratios); nifra vs row divides nifra by that row. req/s is the median over every round: on a",
    `shared runner it moves between jobs, so compare the ratios. A row is noisy when an interval is wider than ${maxCiWidthPts} points.`,
  ].join("\n")
}

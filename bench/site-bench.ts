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

export interface SiteBench {
  readonly _note?: string
  readonly heroSsr: readonly BenchRow[]
  readonly frontend: readonly BenchRow[]
  readonly multipliers: readonly Multiplier[]
  readonly httpRuntime?: readonly HttpRuntimeRow[]
  readonly http: readonly BenchRow[]
  readonly bundle: readonly BundleRow[]
  readonly proof: readonly ProofStat[]
}

const SITE_DATA = join(import.meta.dir, "..", "site", "data", "benchmarks.json")

/** Merge a partial set of slices over the current data — pure; only the passed slices change. */
export function mergeSiteBench(current: SiteBench, partial: Partial<SiteBench>): SiteBench {
  return { ...current, ...partial }
}

/** The HTTP slice the landing shows: Node, `GET /users/:id` (routing + path param — the representative
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

/** Read the site data, merge the slice, write it back (stable 2-space JSON). No-ops on an empty slice. */
export async function writeSiteBench(partial: Partial<SiteBench>): Promise<void> {
  if (Object.keys(partial).length === 0) return
  const current = (await Bun.file(SITE_DATA).json()) as SiteBench
  await Bun.write(SITE_DATA, `${JSON.stringify(mergeSiteBench(current, partial), null, 2)}\n`)
  process.stderr.write(`updated site/data/benchmarks.json (${Object.keys(partial).join(", ")})\n`)
}

/**
 * Import a complete `benchmark-accuracy.yml` artifact download into the public site dataset.
 * The artifact source commit must carry the same core version as this checkout, and SSR client
 * payload sizes must come from `BENCH_SSR_RESULTS_JSON` on that same version.
 *
 *   bun run bench/ci/import-public-site.ts /tmp/nifra-bench-run /tmp/ssr-payloads.json
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isJsonRecord, parseJson, readJson, readJsonRecord } from "../../scripts/read-json.ts"
import { type Matrix, type MatrixCell, median, mergeRuns } from "../rounds.ts"
import {
  type CapturedMeta,
  type CaptureMachine,
  httpRealworldFromResults,
  httpSliceFromNode,
  httpWorkloadsFromResults,
  NIFRA_VERSION,
  type RuntimeVersions,
  writeSiteBench,
} from "../site-bench.ts"
import { ciWorkloads, forRuntime, SSR_RUNTIMES } from "../ssr/matrix.ts"
import {
  frontendSlice,
  heroSsrSlice,
  multipliersSlice,
  type SsrRunRow,
  ssrTablesSlice,
  ssrTargetVersion,
} from "../ssr/site-slice.ts"
import { ALL_TABLE_SECTIONS } from "../ssr/targets.ts"
import { type CiReport, parseCiReport, type Runtime, type Suite } from "./report.ts"

interface RunIdentity {
  readonly commit: string
  readonly runId: string
  readonly date: string
}

interface PayloadRow {
  readonly target: { readonly name: string }
  readonly result: { readonly payloadRaw: number; readonly payloadGzip: number }
}

interface PayloadArtifact {
  readonly nifraVersion: string
  readonly tableA: readonly PayloadRow[]
  readonly tableB: readonly PayloadRow[]
}

function fail(message: string): never {
  throw new Error(message)
}

function isPayloadRow(value: unknown): value is PayloadRow {
  return (
    isJsonRecord(value) &&
    isJsonRecord(value.target) &&
    typeof value.target.name === "string" &&
    isJsonRecord(value.result) &&
    typeof value.result.payloadRaw === "number" &&
    typeof value.result.payloadGzip === "number"
  )
}

function payloadArtifact(value: unknown): PayloadArtifact {
  if (
    !isJsonRecord(value) ||
    typeof value.nifraVersion !== "string" ||
    !Array.isArray(value.tableA) ||
    !Array.isArray(value.tableB)
  ) {
    return fail("SSR payload artifact has an invalid shape")
  }
  const tableA = value.tableA.filter(isPayloadRow)
  const tableB = value.tableB.filter(isPayloadRow)
  if (tableA.length !== value.tableA.length || tableB.length !== value.tableB.length) {
    return fail("SSR payload artifact contains an invalid row")
  }
  return { nifraVersion: value.nifraVersion, tableA, tableB }
}

function metadata(path: string): RunIdentity {
  const source = readFileSync(path, "utf8")
  const value = (key: string): string => {
    const match = source.match(new RegExp(`^${key}=([^\\r\\n]+)$`, "m"))
    if (match?.[1] === undefined) return fail(`${path} is missing ${key}`)
    return match[1]
  }
  const stamp = source.match(/^\d{4}-\d{2}-\d{2}T[^\r\n]+$/m)?.[0]
  if (stamp === undefined) return fail(`${path} is missing its capture timestamp`)
  return { commit: value("commit"), runId: value("run_id"), date: stamp.slice(0, 10) }
}

function readReport(path: string, suite: Suite, runtime: Runtime): CiReport {
  const report = parseCiReport(readJson(path))
  if (report.suite !== suite || report.runtime !== runtime) {
    return fail(`${path} contains ${report.suite}/${report.runtime}; expected ${suite}/${runtime}`)
  }
  return report
}

function captureIdentity(artifactRoot: string): RunIdentity {
  const paths = [
    ...(["bun", "node", "deno"] as const).flatMap((runtime) => [
      join(artifactRoot, "bench-http", "metadata", `http-${runtime}.txt`),
      join(artifactRoot, "bench-realworld", "metadata", `realworld-${runtime}.txt`),
    ]),
    ...SSR_RUNTIMES.map((runtime) =>
      join(artifactRoot, `bench-ssr-${runtime}`, "metadata", `ssr-${runtime}.txt`),
    ),
  ]
  const identities = paths.map(metadata)
  const first = identities[0]
  if (first === undefined) return fail("benchmark artifact download has no metadata")
  if (identities.some((item) => item.commit !== first.commit || item.runId !== first.runId)) {
    return fail("benchmark artifacts came from different commits or workflow runs")
  }
  const measuredPackage = parseJson(
    execFileSync("git", ["show", `${first.commit}:packages/core/package.json`], {
      encoding: "utf8",
    }),
  )
  const measuredVersion = isJsonRecord(measuredPackage) ? measuredPackage.version : undefined
  if (measuredVersion !== NIFRA_VERSION) {
    return fail(
      `benchmark source ${first.commit} has @nifrajs/core ${String(measuredVersion)}; this checkout is ${NIFRA_VERSION}`,
    )
  }
  const manifestVersion = readJsonRecord("server.json").version
  if (manifestVersion !== NIFRA_VERSION) {
    return fail(`server.json is ${String(manifestVersion)}; expected ${NIFRA_VERSION}`)
  }
  return first
}

function combined(reports: readonly CiReport[]): Matrix<MatrixCell> {
  return mergeRuns(
    reports.flatMap((report) => report.runs.map((run) => run.results)),
    () => undefined,
  )
}

function machine(report: CiReport): CaptureMachine {
  return {
    runner: "ubuntu-26.04",
    cpu: report.host.cpuModel ?? "unknown",
    vcpus: report.host.cpus,
  }
}

type ToolVersions = RuntimeVersions & { readonly oha: string }

function runtimeVersions(report: CiReport): ToolVersions {
  const meta = report.runs[0]?.meta
  if (meta === undefined) return fail(`${report.suite}/${report.runtime} has no benchmark runs`)
  const version = (key: string): string => {
    const value = meta[key]
    if (typeof value !== "string")
      return fail(`${report.suite}/${report.runtime} has no ${key} version`)
    return value.replace(/^v/, "")
  }
  return {
    bun: version("bun"),
    node: version("node"),
    deno: version("deno"),
    oha: version("oha"),
  }
}

function captureMeta(
  identity: RunIdentity,
  sourceLabel: string,
  versions: ToolVersions,
  machines: NonNullable<CapturedMeta["machines"]>,
): CapturedMeta {
  return {
    date: identity.date,
    nifraVersion: NIFRA_VERSION,
    bun: versions.bun,
    node: versions.node,
    deno: versions.deno,
    oha: versions.oha,
    source: sourceLabel,
    sourceUrl: `https://github.com/nifrajs/nifra/actions/runs/${identity.runId}`,
    machines,
  }
}

function ssrRows(
  reports: Readonly<Record<"bun" | "node", CiReport>>,
  payloads: PayloadArtifact,
): { tableA: SsrRunRow[]; tableB: SsrRunRow[] } {
  const payloadByTarget = new Map(
    [...payloads.tableA, ...payloads.tableB].map((row) => [row.target.name, row.result]),
  )
  const tableA: SsrRunRow[] = []
  const tableB: SsrRunRow[] = []

  for (const section of ALL_TABLE_SECTIONS) {
    const framework = section.label.split(" - ")[0] ?? section.label
    const output = section.label.includes("Table A") ? tableA : tableB
    for (const runtime of SSR_RUNTIMES) {
      const runtimeSection = forRuntime(section, runtime)
      const workloads = ciWorkloads(runtimeSection)
      for (const target of runtimeSection.targets) {
        // Static-host targets stay in both CI matrices as references; use only their own runtime's run.
        if (target.runtime !== runtime) continue
        const workload = workloads.find((item) => item.rows.includes(target))?.workload
        if (workload === undefined) return fail(`${section.label}: no workload for ${target.name}`)
        const rounds = reports[runtime].runs.flatMap(
          (run) => run.results[runtime]?.[target.name]?.[workload]?.rounds ?? [],
        )
        if (rounds.length === 0) return fail(`${section.label}: no rounds for ${target.name}`)
        const payload = payloadByTarget.get(target.name)
        if (payload === undefined) return fail(`SSR payload artifact has no ${target.name}`)
        output.push({
          framework,
          target,
          result: {
            rps: Math.round(median(rounds.map((round) => round.rps))),
            p50ms: median(rounds.map((round) => round.p50ms)),
            p99ms: median(rounds.map((round) => round.p99ms)),
            payloadRaw: payload.payloadRaw,
            payloadGzip: payload.payloadGzip,
          },
          samples: rounds.map((round) => round.rps),
        })
      }
    }
  }
  if (tableA.length === 0 || tableB.length === 0)
    return fail("SSR artifact produced empty site tables")
  return { tableA, tableB }
}

const [artifactRoot, payloadPath] = process.argv.slice(2)
if (artifactRoot === undefined || payloadPath === undefined) {
  fail("usage: bun run bench/ci/import-public-site.ts <artifact-directory> <ssr-payloads.json>")
}
const identity = captureIdentity(artifactRoot)
const runtimes = ["bun", "node", "deno"] as const
const httpReports = runtimes.map((runtime) =>
  readReport(join(artifactRoot, "bench-http", `http-${runtime}.json`), "http", runtime),
)
const realworldReports = runtimes.map((runtime) =>
  readReport(
    join(artifactRoot, "bench-realworld", `realworld-${runtime}.json`),
    "realworld",
    runtime,
  ),
)
const ssrReports = {
  bun: readReport(join(artifactRoot, "bench-ssr-bun", "ssr-bun.json"), "ssr", "bun"),
  node: readReport(join(artifactRoot, "bench-ssr-node", "ssr-node.json"), "ssr", "node"),
}
const memorySite = readJsonRecord(
  join(artifactRoot, "bench-memory", "memory-site", "benchmarks.json"),
)
const payloads = payloadArtifact(readJson(payloadPath))
if (payloads.nifraVersion !== NIFRA_VERSION) {
  fail(`SSR payload artifact is for ${payloads.nifraVersion}; this checkout is ${NIFRA_VERSION}`)
}
const versions = runtimeVersions(httpReports[0]!)
const httpResults = combined(httpReports)
const realworldResults = combined(realworldReports)
const { tableA, tableB } = ssrRows(ssrReports, payloads)
const ciSourceLabel = `GitHub Actions accuracy run #${identity.runId}`
const ssrSourceLabel = `${ciSourceLabel}; SSR payloads rebuilt from Nifra ${NIFRA_VERSION}`
const machines = {
  bun: machine(ssrReports.bun),
  node: machine(ssrReports.node),
  deno: machine(httpReports.find((report) => report.runtime === "deno")!),
}

const updatedSite: Parameters<typeof writeSiteBench>[0] = {
  http: httpSliceFromNode(httpResults.node),
  httpWorkloads: httpWorkloadsFromResults(httpResults, versions),
  httpWorkloadsCaptured: captureMeta(identity, ciSourceLabel, versions, {
    bun: machine(httpReports.find((report) => report.runtime === "bun")!),
    node: machine(httpReports.find((report) => report.runtime === "node")!),
    deno: machines.deno,
  }),
  httpRealworld: httpRealworldFromResults(
    realworldResults,
    {
      get: "GET /api/orders (auth + 3 middleware)",
      post: "POST /api/orders (auth + 3 middleware)",
      body: "GET /api/orders (auth + middleware + body-hash)",
    },
    versions,
  ),
  httpRealworldCaptured: captureMeta(identity, ciSourceLabel, versions, {
    bun: machine(realworldReports.find((report) => report.runtime === "bun")!),
    node: machine(realworldReports.find((report) => report.runtime === "node")!),
    deno: machine(realworldReports.find((report) => report.runtime === "deno")!),
  }),
  heroSsr: heroSsrSlice(tableA, ssrTargetVersion),
  frontend: frontendSlice(tableA, ssrTargetVersion),
  multipliers: multipliersSlice(tableA, ssrTargetVersion),
  ssrTables: ssrTablesSlice(tableA, ssrTargetVersion),
  ssrTablesB: ssrTablesSlice(tableB, ssrTargetVersion),
  ssrCaptured: captureMeta(identity, ssrSourceLabel, versions, {
    bun: machine(ssrReports.bun),
    node: machine(ssrReports.node),
  }),
}

if (memorySite.httpMemory === undefined) {
  await writeSiteBench(updatedSite)
} else {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: writeSiteBench passes this persisted artifact through normalizeHttpMemory, which validates every capture and row before writing.
  await writeSiteBench({ ...updatedSite, httpMemory: memorySite.httpMemory as never })
}

console.log(`Updated public benchmark data from ${NIFRA_VERSION} accuracy run #${identity.runId}.`)

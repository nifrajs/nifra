/**
 * Paired A/B of the routing lanes between two builds of `@nifrajs/core`, in one process (no network).
 *
 *   cp -R packages/core/dist <dir>        # the build to compare against, taken before a change
 *   bun run build                         # the build under test
 *   bun run bench/http/_route-ab.ts --base <dir> [--check]
 *
 * One row per lane a routing change can move: a static hit, a parameter hit, a mixed-segment hit,
 * an unknown path, a known path under the wrong method, and a parameter hit behind request hooks.
 *
 * The two builds run back to back inside each round, in an order that flips every round, and are
 * compared round by round, so whatever the machine is doing in a given second lands on both sides.
 * That is repeated in several fresh processes and the reported figure is the median across them:
 * inside one process the two copies of the same code can settle into different compiled shapes, and
 * that alone was measured at up to 4% between two copies of one build. A fresh process rolls that
 * again, so the median across processes cancels it. Passing the same build on both sides shows the
 * floor on a given machine.
 *
 * `--check` fails when a row's median is more than 3% slower than the base. It is a tool for a
 * change to the router or the dispatch path, not a CI gate: `check:core-performance` stays the
 * absolute budget, because a shared runner cannot hold a 3% line.
 */

import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

type Core = typeof import("../../packages/core/dist/server.js")
interface App {
  fetch(request: Request): Response | Promise<Response>
}

const N = 50_000
const WARMUP = 50_000
const ROUNDS = 9
const PROCESSES = 8
const MAX_RATIO = 1.03
const CHECK = process.argv.includes("--check")
const CHILD = process.argv.includes("--child")

const baseFlag = process.argv.indexOf("--base")
const baseDir = baseFlag === -1 ? undefined : process.argv[baseFlag + 1]
if (baseDir === undefined) {
  throw new Error("usage: bun run bench/http/_route-ab.ts --base <dir with a core dist> [--check]")
}

const plain = (core: Core): App =>
  core
    .server()
    .get("/", () => ({ ok: true }))
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .get("/files/:name.json", (c) => ({ name: c.params.name }))

const hooked = (core: Core): App =>
  core
    .server()
    .onRequest(() => undefined)
    .beforeHandle(() => undefined)
    .get("/users/:id", (c) => ({ id: c.params.id }))

interface Row {
  readonly name: string
  readonly app: (core: Core) => App
  readonly make: () => Request
}

const rows: readonly Row[] = [
  { name: "static hit", app: plain, make: () => new Request("http://x/") },
  { name: "param hit", app: plain, make: () => new Request("http://x/users/123") },
  { name: "mixed hit", app: plain, make: () => new Request("http://x/files/report.json") },
  { name: "404", app: plain, make: () => new Request("http://x/missing/path") },
  { name: "405", app: plain, make: () => new Request("http://x/", { method: "DELETE" }) },
  { name: "hooked param", app: hooked, make: () => new Request("http://x/users/123") },
]

/** One process's result for one row: the two medians and the median of the per-round ratios. */
interface Sample {
  readonly base: number
  readonly head: number
  readonly ratio: number
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const upper = sorted[Math.floor(sorted.length / 2)] ?? 0
  // An even count has two middle values; taking the upper one alone would lean every figure slow.
  return sorted.length % 2 === 1 ? upper : (upper + (sorted[sorted.length / 2 - 1] ?? upper)) / 2
}

async function nsPerOp(app: App, make: () => Request, count: number): Promise<number> {
  const t0 = Bun.nanoseconds()
  for (let i = 0; i < count; i++) await app.fetch(make())
  return (Bun.nanoseconds() - t0) / count
}

async function measureInProcess(dir: string, headFirst: boolean): Promise<Sample[]> {
  const load = async (from: string): Promise<Core> =>
    (await import(pathToFileURL(join(resolve(from), "server.js")).href)) as Core
  const headDir = join(import.meta.dir, "../../packages/core/dist")
  // Which build is imported, built and warmed first alternates from process to process, so an
  // advantage that belongs to going first is not credited to either build.
  const first = await load(headFirst ? headDir : dir)
  const second = await load(headFirst ? dir : headDir)
  const base = headFirst ? second : first
  const head = headFirst ? first : second
  const samples: Sample[] = []
  for (const row of rows) {
    const a = row.app(base)
    const b = row.app(head)
    for (const app of headFirst ? [b, a] : [a, b]) await nsPerOp(app, row.make, WARMUP)
    const baseNs: number[] = []
    const headNs: number[] = []
    const ratios: number[] = []
    for (let round = 0; round < ROUNDS; round++) {
      // base, head, head, base: each build holds the early slot once and the late slot once, which
      // cancels both the position inside a round and any steady drift across it.
      let left = await nsPerOp(a, row.make, N)
      let right = await nsPerOp(b, row.make, N)
      right += await nsPerOp(b, row.make, N)
      left += await nsPerOp(a, row.make, N)
      baseNs.push(left / 2)
      headNs.push(right / 2)
      ratios.push(right / left)
    }
    samples.push({ base: median(baseNs), head: median(headNs), ratio: median(ratios) })
  }
  return samples
}

if (CHILD) {
  console.log(
    JSON.stringify(await measureInProcess(baseDir, process.argv.includes("--head-first"))),
  )
} else {
  const runs: Sample[][] = []
  for (let i = 0; i < PROCESSES; i++) {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "run",
        import.meta.path,
        "--base",
        baseDir,
        "--child",
        ...(i % 2 === 1 ? ["--head-first"] : []),
      ],
      { stdout: "pipe", stderr: "inherit" },
    )
    if (child.exitCode !== 0) throw new Error(`measurement process ${i + 1} failed`)
    runs.push(JSON.parse(child.stdout.toString()) as Sample[])
  }

  const percent = (ratio: number): string =>
    `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(1)}%`
  const failures: string[] = []
  console.log(
    `\nRouting lanes, head vs base - ${PROCESSES} processes x ${ROUNDS} rounds of ${N * 2} requests per build\n`,
  )
  console.log(
    `  ${"lane".padEnd(14)}${"base".padEnd(10)}${"head".padEnd(10)}${"head/base".padEnd(12)}range`,
  )
  rows.forEach((row, index) => {
    const samples = runs.map((run) => run[index] as Sample)
    const ratios = samples.map((sample) => sample.ratio)
    const ratio = median(ratios)
    console.log(
      `  ${row.name.padEnd(14)}${`${median(samples.map((s) => s.base)).toFixed(0)} ns`.padEnd(10)}${`${median(samples.map((s) => s.head)).toFixed(0)} ns`.padEnd(10)}${percent(ratio).padEnd(12)}${percent(Math.min(...ratios))} .. ${percent(Math.max(...ratios))}`,
    )
    if (ratio > MAX_RATIO) failures.push(`${row.name}: ${percent(ratio)}`)
  })

  if (CHECK && failures.length > 0) {
    throw new Error(
      `routing lanes slower than the base by more than ${((MAX_RATIO - 1) * 100).toFixed(0)}%:\n  ${failures.join("\n  ")}`,
    )
  }
  if (CHECK) console.log("\nrouting lane A/B passed")
}

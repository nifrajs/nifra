/**
 * TEMPORARY: interleaved throughput comparison of a gzipped JSON route across checkouts of this
 * repo and a bare Bun.serve, on one Linux runner. Remove with the workflow that runs it.
 *
 *   bun run bench/tmp-gzip-gap/harness.ts --arm floor --arm main=../arms/main --arm head=../arms/head
 *
 * An `--arm name=dir` arm runs server-nifra.ts inside `dir`; `--arm floor` runs server-floor.ts.
 * Arms are measured round-robin with the starting arm rotated each round. Naming one directory
 * twice gives an A/A pair that shows the noise floor.
 */
import { appendFileSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { get } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { readCoreSplit, readCpuModel, readCpuTimes, stealShare } from "../ci/host.ts"

interface Arm {
  readonly name: string
  readonly dir: string | undefined
  readonly style: string
}

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : (args[at + 1] ?? fallback)
}
const rounds = Number(flag("rounds", "5"))
const seconds = Number(flag("seconds", "8"))
const warm = Number(flag("warm", "2"))
const conns = Number(flag("conns", "256"))
const items = Number(flag("items", "50"))
const port = 18080
const outPath = flag("out", "")

const arms: Arm[] = []
args.forEach((value, at) => {
  if (value !== "--arm") return
  const spec = args[at + 1] ?? ""
  const eq = spec.indexOf("=")
  const sign = spec.indexOf("@")
  const style = sign === -1 ? "json" : spec.slice(sign + 1)
  const end = sign === -1 ? spec.length : sign
  arms.push(
    eq === -1
      ? { name: spec.slice(0, end), dir: undefined, style }
      : { name: spec.slice(0, eq), dir: resolve(spec.slice(eq + 1, end)), style },
  )
})
if (arms.length < 2) throw new Error("name at least two --arm values")

/** A deterministic dataset with the shape and size of a typical catalogue row (~170 B of JSON). */
function dataset(): string {
  let state = 0x9e3779b9
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(list: readonly T[]): T => {
    const value = list[Math.floor(next() * list.length)]
    if (value === undefined) throw new Error("pick from an empty list")
    return value
  }
  const words = ["Prime", "Nano", "Alpha", "Swift", "Core", "Flex", "Edge", "Ultra", "Pro", "Smart"]
  const kinds = ["Gear", "Gadget", "Widget", "Switch", "Relay", "Module", "Link", "Driver", "Valve"]
  const categories = ["home", "books", "office", "toys", "sports", "auto", "garden", "electronics"]
  const tags = ["heavy-duty", "wireless", "fast", "compact", "eco", "premium", "limited", "new"]
  const rows = Array.from({ length: Math.max(items, 50) }, (_, i) => ({
    id: i + 1,
    name: `${pick(words)} ${pick(kinds)} ${i + 1}`,
    category: pick(categories),
    price: 10 + Math.floor(next() * 490),
    quantity: Math.floor(next() * 900),
    active: next() > 0.5,
    tags: Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(tags)),
    rating: { score: 1 + Math.floor(next() * 50), count: Math.floor(next() * 500) },
  }))
  return JSON.stringify(rows)
}

const split = readCoreSplit()
const serverCpus = split === undefined ? undefined : split.server.join(",")
const loadCpus = split === undefined ? undefined : split.load.join(",")
const procs = split === undefined ? 2 : Math.max(1, split.server.length)
const pinned = (cpus: string | undefined, argv: string[]): string[] =>
  cpus === undefined ? argv : ["taskset", "-c", cpus, ...argv]

const workDir = mkdtempSync(join(tmpdir(), "gzip-gap-"))
const datasetPath = join(workDir, "dataset.json")
writeFileSync(datasetPath, dataset())
const env = { ...process.env, GZIP_GAP_DATASET: datasetPath, GZIP_GAP_PORT: String(port) }

function serverFor(arm: Arm): { file: string; cwd: string } {
  if (arm.dir === undefined) return { file: join(here, "server-floor.ts"), cwd: here }
  const file = join(arm.dir, "bench", "tmp-gzip-gap-server.ts")
  copyFileSync(join(here, "server-nifra.ts"), file)
  return { file, cwd: arm.dir }
}

/** One gzip request through node:http, which does not decode the body behind our back. */
function fetchGzip(): Promise<{ encoding: string | undefined; body: Buffer }> {
  return new Promise((resolveRequest, reject) => {
    get(
      `http://127.0.0.1:${port}/json/${items}`,
      { headers: { "accept-encoding": "gzip" } },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => {
          const encoding = res.headers["content-encoding"]
          resolveRequest({
            encoding: Array.isArray(encoding) ? encoding.join(",") : encoding,
            body: Buffer.concat(chunks),
          })
        })
      },
    ).on("error", reject)
  })
}

async function ready(): Promise<void> {
  const until = Date.now() + 30_000
  for (;;) {
    try {
      await fetchGzip()
      return
    } catch (error) {
      if (Date.now() > until) throw error
      await Bun.sleep(200)
    }
  }
}

/** Fail loudly if an arm is not answering the route the way the comparison assumes. */
async function verify(arm: Arm): Promise<number> {
  const { encoding, body } = await fetchGzip()
  if (encoding !== "gzip") throw new Error(`${arm.name}: content-encoding is ${encoding}`)
  const parsed: unknown = JSON.parse(gunzipSync(body).toString("utf8"))
  const count =
    typeof parsed === "object" && parsed !== null && "count" in parsed ? parsed.count : undefined
  if (count !== items) throw new Error(`${arm.name}: answered count ${String(count)}`)
  return body.byteLength
}

async function load(duration: number): Promise<number> {
  const argv = [
    "oha",
    "-z",
    `${duration}s`,
    "-c",
    String(conns),
    "--no-tui",
    "--output-format",
    "json",
    "-H",
    "accept-encoding: gzip",
    `http://127.0.0.1:${port}/json/${items}`,
  ]
  const run = Bun.spawn(pinned(loadCpus, argv), { stdout: "pipe", stderr: "inherit" })
  const text = await new Response(run.stdout).text()
  await run.exited
  const report: unknown = JSON.parse(text)
  if (typeof report !== "object" || report === null || !("summary" in report)) {
    throw new Error("oha printed no summary")
  }
  const summary = report.summary
  if (typeof summary !== "object" || summary === null) throw new Error("oha summary is empty")
  const rps = "requestsPerSec" in summary ? summary.requestsPerSec : undefined
  const success = "successRate" in summary ? summary.successRate : undefined
  if (typeof rps !== "number") throw new Error("oha reported no requestsPerSec")
  if (success !== 1) throw new Error(`oha success rate ${String(success)}`)
  return rps
}

async function measure(arm: Arm): Promise<{ rps: number; gzBytes: number }> {
  const { file, cwd } = serverFor(arm)
  const servers = Array.from({ length: procs }, () =>
    Bun.spawn(pinned(serverCpus, ["bun", "run", file]), {
      cwd,
      env: { ...env, GZIP_GAP_STYLE: arm.style },
      stdout: "ignore",
      stderr: "inherit",
    }),
  )
  try {
    await ready()
    const gzBytes = await verify(arm)
    await load(warm)
    return { rps: await load(seconds), gzBytes }
  } finally {
    for (const server of servers) server.kill()
    await Promise.all(servers.map((server) => server.exited))
    await Bun.sleep(500)
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2
}

const results = new Map<string, number[]>(arms.map((arm) => [arm.name, []]))
let gzBytes = 0
const before = readCpuTimes()
for (let round = 0; round < rounds; round++) {
  const order = [...arms.slice(round % arms.length), ...arms.slice(0, round % arms.length)]
  const line: string[] = []
  for (const arm of order) {
    const result = await measure(arm)
    gzBytes = result.gzBytes
    results.get(arm.name)?.push(result.rps)
    line.push(`${arm.name}=${Math.round(result.rps)}`)
  }
  console.log(`round ${round + 1}: ${line.join(" ")}`)
}
const after = readCpuTimes()
const steal = before === undefined || after === undefined ? undefined : stealShare(before, after)

const floorMedian = median(results.get("floor") ?? [])
const pct = (value: number, base: number): string =>
  base > 0 ? `${((value / base - 1) * 100).toFixed(1)}%` : "n/a"
const lines = [
  "| arm | median rps | min | max | vs floor |",
  "|---|---|---|---|---|",
  ...arms.map((arm) => {
    const list = results.get(arm.name) ?? []
    const mid = median(list)
    return `| ${arm.name} | ${Math.round(mid)} | ${Math.round(Math.min(...list))} | ${Math.round(Math.max(...list))} | ${floorMedian > 0 ? pct(mid, floorMedian) : "n/a"} |`
  }),
]
const header = [
  `gzip /json/${items}: ${gzBytes} B gzipped, ${conns} connections, ${seconds}s per measurement, ${rounds} rounds, rotated order`,
  `server CPUs ${serverCpus ?? "unpinned"} (${procs} processes), load CPUs ${loadCpus ?? "unpinned"}, CPU ${readCpuModel() ?? "unknown"}`,
  `hypervisor steal ${steal === undefined ? "unknown" : `${(steal * 100).toFixed(2)}%`}`,
]
const report = [...header, "", ...lines].join("\n")
console.log(`\n${report}`)
const summaryFile = process.env.GITHUB_STEP_SUMMARY
if (summaryFile !== undefined) appendFileSync(summaryFile, `### Gzip comparison\n\n${report}\n`)
if (outPath !== "") {
  writeFileSync(
    outPath,
    JSON.stringify(
      { rounds, seconds, conns, items, gzBytes, steal, results: Object.fromEntries(results) },
      null,
      2,
    ),
  )
}

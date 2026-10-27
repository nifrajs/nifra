/** Temporary same-run HTTP comparison. Every arm is a separately bundled historical snapshot. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readCoreSplit } from "../ci/host.ts"

const runtime = process.argv[2]
if (!["bun", "bun-fetch", "node", "deno"].includes(runtime ?? "")) throw Error("unknown runtime")
const rounds = Number(process.env.TEMP_PERF_ROUNDS ?? 8)
const requests = Number(process.env.TEMP_PERF_REQUESTS ?? 20000)
const versions = {
  baseline: "377711ab7d",
  candidate: "ddeb735c8",
} as const
type Version = keyof typeof versions
const pairs: ReadonlyArray<readonly [string, Version, Version]> = [
  ["A/A control", "baseline", "baseline"],
  ["Deno JSON candidate", "baseline", "candidate"],
  ["A/A control (end)", "baseline", "baseline"],
]
const split = readCoreSplit()
if (split === undefined || split === null) throw Error("Linux CPU pinning is required")
const out = join(process.cwd(), "bench-ci", `temporary-${runtime}.json`)
const scratch = await mkdtemp(join(tmpdir(), "nifra-perf-ci-"))
const artifacts: Record<string, string> = {}
const report: {
  runtime: string
  versions: typeof versions
  split: typeof split
  rounds: number
  requests: number
  results: unknown[]
} = {
  runtime: runtime!,
  versions,
  split,
  rounds,
  requests,
  results: [],
}
await mkdir(join(process.cwd(), "bench-ci"), { recursive: true })
async function save() {
  await writeFile(out, JSON.stringify(report, null, 2))
}
await save()
async function command(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "production" },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw Error(`${args.join(" ")} failed (${code}): ${stderr.slice(-4000)}`)
  return stdout
}
function fixture(): string {
  const start =
    runtime === "node"
      ? 'const { serve } = await import("./packages/node/src/index.ts"); await serve(app, { port, hostname: "127.0.0.1" })'
      : runtime === "deno"
        ? 'Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, r => { r[Symbol.for("nifra.body.trustedFraming")] = true; return app.fetch(r) })'
        : runtime === "bun-fetch"
          ? 'Bun.serve({ port, hostname: "127.0.0.1", fetch: r => app.fetch(r) })'
          : 'app.listen(port, { hostname: "127.0.0.1" })'
  return `import { server } from "./packages/core/src/server.ts"
const schema = { "~standard": { version: 1, vendor: "temporary-bench", validate(v) { return v && typeof v.name === "string" && typeof v.age === "number" ? { value: v } : { issues: [{ message: "invalid" }] } } } }
const app = server().get("/users/:id", c => ({ id: c.params.id })).post("/users", { body: schema }, c => ({ id: "1", name: c.body.name }))
const port = Number(globalThis.Deno ? Deno.args[0] : process.argv[2]); ${start}
`
}
async function prepare(name: Version): Promise<void> {
  const dir = join(scratch, name)
  await mkdir(dir)
  // Both inputs come from the fixed table above, never from PR text or workflow inputs.
  await command(
    ["bash", "-c", `git archive ${versions[name]} | tar -x -C "$1"`, "archive", dir],
    process.cwd(),
  )
  await command(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], dir)
  const entry = join(dir, "temporary-bench-entry.ts")
  await writeFile(entry, fixture())
  const build = await Bun.build({
    entrypoints: [entry],
    target: "node",
    format: "esm",
    outdir: join(dir, "bench-build"),
  })
  if (!build.success) throw Error(`bundle ${name}: ${build.logs.join("\n")}`)
  const output = build.outputs.find((item) => item.kind === "entry-point")
  if (output === undefined) throw Error(`bundle ${name} produced no entry`)
  artifacts[name] = output.path
}
function launch(name: Version, port: number) {
  const executable =
    runtime === "node"
      ? ["node", artifacts[name]!, String(port)]
      : runtime === "deno"
        ? [
            "deno",
            "run",
            "--allow-net",
            "--allow-env",
            "--allow-read",
            artifacts[name]!,
            String(port),
          ]
        : ["bun", artifacts[name]!, String(port)]
  return Bun.spawn(["taskset", "-c", split!.server.join(","), ...executable], {
    stdout: "ignore",
    stderr: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  })
}
async function ready(port: number) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/users/123`, {
        signal: AbortSignal.timeout(500),
      })
      if (r.status === 200 && (await r.text()) === '{"id":"123"}') return
    } catch {}
    await Bun.sleep(100)
  }
  throw Error(`server on ${port} not ready or returned wrong body`)
}
async function validatePost(port: number) {
  const r = await fetch(`http://127.0.0.1:${port}/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"name":"Ada","age":36}',
  })
  if (r.status !== 200 || (await r.text()) !== '{"id":"1","name":"Ada"}')
    throw Error(`invalid POST on ${port}`)
}
async function sample(port: number, method: "GET" | "POST"): Promise<number> {
  const post =
    method === "POST"
      ? ["-m", "POST", "-T", "application/json", "-d", '{"name":"Ada","age":36}']
      : []
  const path = method === "GET" ? "/users/123" : "/users"
  const raw = await command(
    [
      "taskset",
      "-c",
      split!.load.join(","),
      "oha",
      "--no-tui",
      "--output-format",
      "json",
      "-n",
      String(requests),
      "-c",
      "32",
      ...post,
      `http://127.0.0.1:${port}${path}`,
    ],
    process.cwd(),
  )
  const json = JSON.parse(raw) as {
    summary: { requestsPerSec: number }
    statusCodeDistribution: Record<string, number>
  }
  if (
    json.statusCodeDistribution["200"] !== requests ||
    !Number.isFinite(json.summary.requestsPerSec)
  )
    throw Error(`bad load result: ${raw.slice(0, 1500)}`)
  return json.summary.requestsPerSec
}
const median = (items: number[]) => {
  const a = [...items].sort((x, y) => x - y)
  const i = Math.floor(a.length / 2)
  return a.length % 2 ? a[i]! : (a[i - 1]! + a[i]!) / 2
}
try {
  for (const name of Object.keys(versions) as Version[]) {
    console.log(`Preparing ${name} (${versions[name]})`)
    await prepare(name)
  }
  const summary: string[] = [
    `## Temporary paired HTTP benchmarks - ${runtime}`,
    "",
    `Each side serves ${requests} requests, ${rounds} alternating rounds; ratios are candidate/base. A/A is the noise control. Ranges show the full observed paired range, not confidence intervals.`,
    "",
    "| comparison | route | median ratio | paired range |",
    "| --- | --- | ---: | ---: |",
  ]
  for (const [label, base, candidate] of pairs) {
    const servers = [launch(base, 19101), launch(candidate, 19102)]
    try {
      await Promise.all([ready(19101), ready(19102)])
      await Promise.all([validatePost(19101), validatePost(19102)])
      for (const method of ["GET", "POST"] as const) {
        const values: [number[], number[]] = [[], []]
        // Warm both servers and the load generator before taking a paired sample.
        await sample(19101, method)
        await sample(19102, method)
        for (let i = 0; i < rounds; i++)
          for (const arm of i % 2 === 0 ? [0, 1] : [1, 0])
            values[arm]!.push(await sample(19101 + arm, method))
        const ratios = values[0].map((x, i) => values[1][i]! / x)
        report.results.push({ label, base, candidate, method, values, ratios })
        await save()
        const row = `| ${label} | ${method} | ${median(ratios).toFixed(3)} | ${Math.min(...ratios).toFixed(3)} - ${Math.max(...ratios).toFixed(3)} |`
        summary.push(row)
        console.log(row)
      }
    } finally {
      for (const proc of servers) proc.kill()
      await Promise.all(servers.map((p) => p.exited))
    }
  }
  const text = summary.join("\n") + "\n"
  if (process.env.GITHUB_STEP_SUMMARY) await Bun.write(process.env.GITHUB_STEP_SUMMARY, text)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const root = process.cwd()
const variants = join(root, "bench/temporary-get-profile/deno-peer-variants")
const resultPath = join(root, "bench/temporary-get-results/deno-peer-ablation.json")
for (const name of ["normal", "lazy"])
  await cp(join(root, "packages/deno/src"), join(variants, name), { recursive: true })
const target = join(variants, "lazy/index.ts")
const source = await readFile(target, "utf8")
const original = `const clientIp = info.remoteAddr?.hostname
      const response =
        clientIp === undefined ? app.fetch(request) : app.fetch(request, { clientIp })`
const replacement = `const response = app.fetch(request, { get clientIp() { return info.remoteAddr?.hostname } })`
if (source.split(original).length !== 2) throw new Error("adapter peer location changed")
await writeFile(target, source.replace(original, replacement))

const serverCpus = process.env.SERVER_CPUS
const loadCpus = process.env.LOAD_CPUS
if (!serverCpus || !loadCpus) throw new Error("physical core split is required")
const rounds = 8
const requests = 30000
const ports = [19781, 19782, 19783]
const modes = ["normal", "normal", "lazy"]
const result: unknown[] = []
const median = (xs: number[]) => {
  const x = [...xs].sort((a, b) => a - b)
  return (x[3]! + x[4]!) / 2
}
await mkdir(join(root, "bench/temporary-get-results"), { recursive: true })
const headers: Record<string, string> = {
  authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
  cookie: "theme=dark",
  origin: "https://app.example.com",
  "x-request-id": "bench-1",
}
async function ready(port: number, path: string) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers,
        signal: AbortSignal.timeout(500),
      })
      if (r.status === 200) return await r.text()
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(`not ready: ${port}`)
}
async function sample(port: number, path: string) {
  const args = [
    "taskset",
    "-c",
    loadCpus!,
    "oha",
    "--no-tui",
    "--output-format",
    "json",
    "-n",
    String(requests),
    "-c",
    "32",
  ]
  for (const [key, value] of Object.entries(headers)) args.push("-H", `${key}: ${value}`)
  args.push(`http://127.0.0.1:${port}${path}`)
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(`oha: ${err}`)
  const json = JSON.parse(out)
  if (json.statusCodeDistribution?.["200"] !== requests || json.summary?.successRate !== 1)
    throw new Error(`bad load: ${out.slice(0, 1000)}`)
  return json.summary.requestsPerSec as number
}
for (const shape of ["bare", "realworld"]) {
  const path = shape === "bare" ? "/users/123" : "/api/orders?limit=10"
  const children = modes.map((mode, i) =>
    Bun.spawn(
      [
        "taskset",
        "-c",
        serverCpus!,
        "deno",
        "run",
        "--no-check",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        "bench/temporary-get-profile/deno-peer-server.ts",
        mode,
        shape,
        String(ports[i]),
      ],
      { stdout: "ignore", stderr: "inherit", env: { ...process.env, NODE_ENV: "production" } },
    ),
  )
  try {
    const bodies = await Promise.all(ports.map((p) => ready(p, path)))
    if (!bodies.every((body) => body === bodies[0])) throw new Error("response body mismatch")
    for (const port of ports)
      if (JSON.parse(await ready(port, "/__peer")).peer !== "127.0.0.1")
        throw new Error("peer mismatch")
    for (const port of ports) await sample(port, path)
    const values: number[][] = [[], [], []]
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? [0, 1, 2] : [2, 1, 0]
      for (const arm of order) values[arm]!.push(await sample(ports[arm]!, path))
    }
    const aa = values[1]!.map((x, i) => x / values[0]![i]!)
    const lazy = values[2]!.map((x, i) => x / values[0]![i]!)
    result.push({ shape, requests, rounds, values, aa, lazy })
    console.log(
      `${shape} A/A ${median(aa).toFixed(3)} (${Math.min(...aa).toFixed(3)}..${Math.max(...aa).toFixed(3)}) lazy ${median(lazy).toFixed(3)} (${Math.min(...lazy).toFixed(3)}..${Math.max(...lazy).toFixed(3)})`,
    )
    await writeFile(resultPath, JSON.stringify(result, null, 2))
  } finally {
    for (const child of children) child.kill()
    await Promise.all(children.map((child) => child.exited))
  }
}

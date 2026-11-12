// node bench/node-uws/bench.mjs [rounds] [seconds] [connections]
// Interleaved A/B of the same nifra app on node:http (@nifrajs/node serve) vs the uWS spike.
// Each sample is discarded if other processes were busy before, 400 ms into, or after the run.
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const rounds = Number(process.argv[2] ?? 7)
const secs = Number(process.argv[3] ?? 6)
const conns = Number(process.argv[4] ?? 50)
const dir = fileURLToPath(new URL(".", import.meta.url))
const AUTH = "Bearer abcdefghijklmnopqrstuvwxyz"
const ports = { node: { bare: 47311, real: 47312 }, uws: { bare: 47321, real: 47322 } }

const shapes = [
  { name: "bare GET /", app: "bare", path: "/", args: [] },
  {
    name: "real GET /api/orders?limit=10",
    app: "real",
    path: "/api/orders?limit=10",
    args: ["-H", `authorization: ${AUTH}`, "-H", "cookie: theme=dark"],
  },
  {
    name: "real POST /api/orders",
    app: "real",
    path: "/api/orders",
    args: [
      "-m",
      "POST",
      "-H",
      `authorization: ${AUTH}`,
      "-H",
      "content-type: application/json",
      "-d",
      '{"sku":"SKU-1","qty":2,"note":"hello"}',
    ],
  },
]

const servers = []
for (const transport of ["node", "uws"]) {
  for (const app of ["bare", "real"]) {
    const child = spawn(
      "node",
      [`${dir}dist/serve.js`, transport, app, String(ports[transport][app])],
      {
        stdio: "ignore",
        // uWebSockets.js is a devDependency of packages/node-uws; the bundle keeps it external.
        env: { ...process.env, NODE_PATH: `${dir}../../packages/node-uws/node_modules` },
      },
    )
    servers.push({ transport, app, pid: child.pid, child })
  }
}
const ours = new Set(servers.map((s) => s.pid))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(2500)

function othersCpu() {
  const out = execFileSync("ps", ["-Ao", "pid,pcpu,comm"], { encoding: "utf8" })
  let sum = 0
  for (const line of out.split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.*)$/)
    if (!m) continue
    if (ours.has(Number(m[1])) || /\/oha$|^oha$|\/ps$|^ps$/.test(m[3])) continue
    sum += Number(m[2])
  }
  return sum
}
const CPU_LIMIT = 650
async function quiet() {
  for (let i = 0; i < 90; i++) {
    if (othersCpu() < CPU_LIMIT) return true
    await sleep(1000)
  }
  return false
}
function cpuSeconds(pid) {
  const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim()
  const [mins, rest] = t.split(":")
  return Number(mins) * 60 + Number(rest)
}

async function sample(shape, transport) {
  const server = servers.find((s) => s.transport === transport && s.app === shape.app)
  const port = ports[transport][shape.app]
  if (!(await quiet())) return { discarded: "never quiet" }
  const before = othersCpu()
  const cpu0 = cpuSeconds(server.pid)
  const proc = spawn(
    "oha",
    [
      "-c",
      String(conns),
      "-z",
      `${secs}s`,
      "--no-tui",
      "--output-format",
      "json",
      ...shape.args,
      `http://127.0.0.1:${port}${shape.path}`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  )
  let out = ""
  proc.stdout.on("data", (d) => (out += d))
  await sleep(400)
  const mid = othersCpu()
  await new Promise((r) => proc.on("close", r))
  const after = othersCpu()
  const cpu1 = cpuSeconds(server.pid)
  const j = JSON.parse(out)
  const total = Object.values(j.statusCodeDistribution).reduce((a, b) => a + b, 0)
  const ok = j.statusCodeDistribution["200"] ?? 0
  const maxOther = Math.max(before, mid, after)
  if (maxOther >= CPU_LIMIT) return { discarded: `others ${maxOther.toFixed(0)}%` }
  if (ok !== total) return { discarded: `non-200: ${JSON.stringify(j.statusCodeDistribution)}` }
  return {
    rps: j.summary.requestsPerSec,
    p99: j.latencyPercentiles.p99 * 1000,
    usPerReq: ((cpu1 - cpu0) / total) * 1e6,
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const results = {}
for (const shape of shapes) {
  results[shape.name] = { node: [], uws: [] }
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? ["node", "uws"] : ["uws", "node"]
    const pair = {}
    for (const transport of order) pair[transport] = await sample(shape, transport)
    for (const t of order) {
      if (pair[t].discarded) console.log(`  discard ${shape.name} r${r} ${t}: ${pair[t].discarded}`)
    }
    if (pair.node.discarded || pair.uws.discarded) continue
    results[shape.name].node.push(pair.node)
    results[shape.name].uws.push(pair.uws)
    console.log(
      `${shape.name} r${r}: node ${pair.node.rps.toFixed(0)} uws ${pair.uws.rps.toFixed(0)} ratio ${(pair.uws.rps / pair.node.rps).toFixed(3)}`,
    )
  }
}

console.log("\n== summary (paired, clean samples only) ==")
for (const [name, r] of Object.entries(results)) {
  const n = r.node.length
  if (n === 0) {
    console.log(`${name}: no clean samples`)
    continue
  }
  const ratios = r.node.map((x, i) => r.uws[i].rps / x.rps)
  const wins = ratios.filter((x) => x > 1).length
  console.log(
    `${name}: n=${n} node ${median(r.node.map((x) => x.rps)).toFixed(0)} rps / ${median(r.node.map((x) => x.usPerReq)).toFixed(1)} us / p99 ${median(r.node.map((x) => x.p99)).toFixed(2)} ms | ` +
      `uws ${median(r.uws.map((x) => x.rps)).toFixed(0)} rps / ${median(r.uws.map((x) => x.usPerReq)).toFixed(1)} us / p99 ${median(r.uws.map((x) => x.p99)).toFixed(2)} ms | ` +
      `rps ratio median ${median(ratios).toFixed(3)} (uws faster in ${wins}/${n})`,
  )
}
for (const s of servers) s.child.kill()
process.exit(0)

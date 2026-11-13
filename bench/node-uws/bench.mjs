// node bench/node-uws/bench.mjs [rounds] [seconds] [connections] [arms]
//
// Interleaved A/B of the same nifra app behind different HTTP transports, plus a raw uWebSockets.js
// ceiling. `arms` is a comma list of `label=transport@bundle` (transport: node | uws | raw; bundle: a
// file built from serve.ts, default dist/serve.js), e.g.
//   node bench.mjs 9 5 50 node,raw,uws,uws-old=uws@/tmp/old/serve.js
// Each sample is discarded if other processes were busy before, 400 ms into, or after the run.
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const rounds = Number(process.argv[2] ?? 7)
const secs = Number(process.argv[3] ?? 6)
const conns = Number(process.argv[4] ?? 50)
const armSpec = process.argv[5] ?? "node,raw,uws"
const dir = fileURLToPath(new URL(".", import.meta.url))
const AUTH = "Bearer abcdefghijklmnopqrstuvwxyz"

const arms = armSpec.split(",").map((spec, index) => {
  const [label, rest] = spec.includes("=") ? spec.split("=") : [spec, spec]
  const [transport, bundle] = rest.split("@")
  if (!["node", "uws", "raw"].includes(transport)) throw new Error(`unknown transport in ${spec}`)
  return { label, transport, bundle: bundle ?? `${dir}dist/serve.js`, index }
})

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
const only = process.env.SHAPES?.split(",")
const activeShapes =
  only === undefined ? shapes : shapes.filter((s) => only.some((o) => s.name.includes(o)))

const servers = []
// Registered before the first spawn, so a failed startup cleans up too. Servers die with the bench on any exit path: a throw, a failed sample, Ctrl-C.
process.on("exit", () => {
  for (const s of servers) s.child.kill()
})
process.on("SIGINT", () => process.exit(130))
process.on("SIGTERM", () => process.exit(143))
let nextPort = 47400
for (const arm of arms) {
  for (const app of ["bare", "real"]) {
    const port = nextPort++
    const child = spawn("node", [arm.bundle, arm.transport, app, String(port)], {
      stdio: "ignore",
      // uWebSockets.js is a devDependency of packages/node-uws; the bundles keep it external.
      env: { ...process.env, NODE_PATH: `${dir}../../packages/node-uws/node_modules` },
    })
    servers.push({ arm, app, port, pid: child.pid, child })
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
const CPU_LIMIT = Number(process.env.CPU_LIMIT ?? 650)
async function quiet() {
  for (let i = 0; i < 90; i++) {
    if (othersCpu() < CPU_LIMIT) return true
    await sleep(1000)
  }
  return false
}
function cpuSeconds(pid) {
  const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim()
  // `[DD-]HH:MM:SS` on Linux, `MM:SS.ss` or `HH:MM:SS` on macOS.
  const [days, clock] = t.includes("-") ? t.split("-") : [undefined, t]
  const seconds = clock.split(":").reduce((total, part) => total * 60 + Number(part), 0)
  return seconds + (days === undefined ? 0 : Number(days) * 86400)
}

async function sample(shape, arm) {
  const server = servers.find((s) => s.arm === arm && s.app === shape.app)
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
      `http://127.0.0.1:${server.port}${shape.path}`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  )
  let out = ""
  proc.stdout.on("data", (d) => (out += d))
  // Registered before the first await: a short run can finish inside the delay below.
  const finished = new Promise((r) => {
    proc.once("close", (code) => r(code))
    proc.once("error", () => r(-1))
  })
  await sleep(400)
  const mid = othersCpu()
  const exitCode = await finished
  const after = othersCpu()
  const cpu1 = cpuSeconds(server.pid)
  if (exitCode !== 0) return { discarded: `load generator exited ${exitCode}` }
  let j
  try {
    j = JSON.parse(out)
  } catch {
    return { discarded: "load generator produced no result" }
  }
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
for (const shape of activeShapes) {
  results[shape.name] = Object.fromEntries(arms.map((a) => [a.label, []]))
  for (let r = 0; r < rounds; r++) {
    // Rotate the order each round so no arm always runs first or last.
    const order = arms.map((_, i) => arms[(i + r) % arms.length])
    const pair = {}
    for (const arm of order) pair[arm.label] = await sample(shape, arm)
    const bad = arms.filter((a) => pair[a.label].discarded)
    for (const a of bad)
      console.log(`  discard ${shape.name} r${r} ${a.label}: ${pair[a.label].discarded}`)
    if (bad.length > 0) continue
    for (const a of arms) results[shape.name][a.label].push(pair[a.label])
    console.log(
      `${shape.name} r${r}: ${arms.map((a) => `${a.label} ${pair[a.label].rps.toFixed(0)}`).join(" ")}`,
    )
  }
}

console.log("\n== summary (paired, clean samples only) ==")
for (const [name, byArm] of Object.entries(results)) {
  const first = arms[0].label
  const n = byArm[first].length
  if (n === 0) {
    console.log(`${name}: no clean samples`)
    continue
  }
  console.log(`${name} (n=${n})`)
  for (const arm of arms) {
    const rows = byArm[arm.label]
    const ratios = rows.map((x, i) => x.rps / byArm[first][i].rps)
    const wins = ratios.filter((x) => x > 1).length
    console.log(
      `  ${arm.label.padEnd(10)} ${median(rows.map((x) => x.rps))
        .toFixed(0)
        .padStart(7)} rps  ` +
        `${median(rows.map((x) => x.usPerReq))
          .toFixed(2)
          .padStart(6)} us/req  ` +
        `p99 ${median(rows.map((x) => x.p99)).toFixed(2)} ms  ` +
        `x${median(ratios).toFixed(3)} vs ${first} (${wins}/${n})`,
    )
  }
}
process.exit(0)

// Rotated, serial comparison of servers under wrk on one Linux box.
// usage: node compare.mjs   (configuration is env: ROUNDS, TARGETS, WORKLOADS, DURATION, OUT)
// An "#2" suffix on a target repeats it as an A/A control: its gap to the original is noise.
import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const env = process.env
const rounds = Number(env.ROUNDS ?? 5)
const duration = Number(env.DURATION ?? 6)
const targets = (
  env.TARGETS ??
  "raw-nifra-engine,raw-uws,raw-node,raw-moro-engine,nifra-engine,nifra-engine-host,nifra-uws,nifra-node,moro,nifra-engine#2"
).split(",")
const out = env.OUT ?? "bench-out"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const heavy = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Cookie: "session=abcdef0123456789abcdef0123456789; theme=dark; _ga=GA1.2.123456789.1700000000",
  Referer: "http://127.0.0.1/",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
  "Sec-Ch-Ua": '"Chromium";v="130", "Not?A_Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
}
const json = (name) => `{"name":"${name}"}`
const workloads = {
  get: { method: "GET", path: "/user/7" },
  getheavy: { method: "GET", path: "/user/7", headers: heavy },
  post13: {
    method: "POST",
    path: "/users",
    body: json("ab"),
    headers: { "Content-Type": "application/json" },
  },
  post1k: {
    method: "POST",
    path: "/users",
    body: json("a".repeat(1024 - 11)),
    headers: { "Content-Type": "application/json" },
  },
}
const names = (env.WORKLOADS ?? Object.keys(workloads).join(",")).split(",")

mkdirSync(out, { recursive: true })
// Quoted, not a long bracket: `[[==[` would open one as a table index.
const luaString = (s) => JSON.stringify(s)
const luaFor = (name) => {
  const w = workloads[name]
  const lines = [`wrk.method = "${w.method}"`]
  if (w.body !== undefined) lines.push(`wrk.body = ${luaString(w.body)}`)
  for (const [k, v] of Object.entries(w.headers ?? {}))
    lines.push(`wrk.headers[${luaString(k)}] = ${luaString(v)}`)
  const path = join(out, `${name}.lua`)
  writeFileSync(path, `${lines.join("\n")}\n`)
  return path
}
const scripts = Object.fromEntries(names.map((n) => [n, luaFor(n)]))

// Server and client on separate cores when there are enough; otherwise unpinned.
const cpus = availableParallelism()
const half = Math.floor(cpus / 2)
const pin =
  process.platform === "linux" && cpus >= 4
    ? { server: `0-${half - 1}`, client: `${half}-${cpus - 1}`, threads: cpus - half }
    : undefined
const withPin = (set, cmd, args) =>
  pin === undefined ? [cmd, args] : ["taskset", ["-c", set, cmd, ...args]]

const cpuTimes = () => {
  try {
    const f = readFileSync("/proc/stat", "utf8")
      .split("\n")[0]
      .trim()
      .split(/\s+/)
      .slice(1)
      .map(Number)
    return { total: f.reduce((x, y) => x + y, 0), steal: f[7] ?? 0 }
  } catch {
    return { total: 1, steal: 0 }
  }
}
const wrk = (name, url) => {
  const before = cpuTimes()
  const [cmd, args] = withPin(pin?.client, "wrk", [
    `-t${pin?.threads ?? 2}`,
    "-c64",
    `-d${duration}s`,
    "-s",
    scripts[name],
    url,
  ])
  const text = execFileSync(cmd, args).toString()
  const after = cpuTimes()
  const rps = Number(/Requests\/sec:\s+([\d.]+)/.exec(text)?.[1])
  return {
    rps,
    bad: /Non-2xx|Socket errors/.test(text),
    steal: (100 * (after.steal - before.steal)) / Math.max(1, after.total - before.total),
  }
}

const results = {}
for (const name of names) {
  results[name] = {}
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[(i + round) % targets.length]
      const port = 5900 + Math.floor(Math.random() * 1000)
      const [cmd, args] = withPin(pin?.server, "node", [
        join(here, "server.mjs"),
        target.replace(/#\d$/, ""),
        String(port),
      ])
      const child = spawn(cmd, args, {
        env: { ...env, NODE_ENV: "production" },
        stdio: ["ignore", "ignore", "inherit"],
      })
      let run
      try {
        await sleep(3000)
        if (child.exitCode !== null)
          throw new Error(`${target} exited with ${child.exitCode} before it served`)
        const url = `http://127.0.0.1:${port}${workloads[name].path}`
        if (wrk(name, url).bad)
          throw new Error(`${name} on ${target}: warm-up got non-2xx or socket errors`)
        run = wrk(name, url)
      } finally {
        child.kill("SIGTERM")
      }
      await sleep(800)
      results[name][target] = [...(results[name][target] ?? []), run]
      console.error(
        `${name} r${round} ${target} ${Math.round(run.rps)} steal=${run.steal.toFixed(1)}%${run.bad ? " BAD" : ""}`,
      )
    }
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const rows = [
  "| workload | target | median rps | spread | vs moro | vs uws | bad | max steal |",
  "|---|---|---:|---:|---:|---:|---:|---:|",
]
for (const name of names) {
  const baseline = (target) =>
    results[name][target] === undefined
      ? undefined
      : median(results[name][target].map((r) => r.rps))
  const moro = baseline("moro")
  const uws = baseline("nifra-uws")
  const ratio = (med, base) => (base === undefined ? "-" : (med / base).toFixed(3))
  for (const [target, runs] of Object.entries(results[name])) {
    const med = median(runs.map((r) => r.rps))
    const spread = (Math.max(...runs.map((r) => r.rps)) - Math.min(...runs.map((r) => r.rps))) / med
    rows.push(
      `| ${name} | ${target} | ${Math.round(med)} | ${(100 * spread).toFixed(1)}% | ${ratio(med, moro)} | ${ratio(med, uws)} | ${runs.filter((r) => r.bad).length} | ${Math.max(...runs.map((r) => r.steal)).toFixed(1)}% |`,
    )
  }
}
// What each framework costs over its own engine: the same three routes, the same bytes, the same checks
// in the `raw-*` target, so the ratio is the framework layer and nothing else.
const LAYERS = [
  ["nifra on the Rust engine", "nifra-engine", "raw-nifra-engine"],
  ["nifra on uWebSockets.js", "nifra-uws", "raw-uws"],
  ["nifra on node:http", "nifra-node", "raw-node"],
  ["Moro", "moro", "raw-moro-engine"],
]
const layerRows = [
  "| workload | stack | framework rps | raw rps | framework / raw |",
  "|---|---|---:|---:|---:|",
]
for (const name of names) {
  for (const [label, framework, raw] of LAYERS) {
    if (results[name][framework] === undefined || results[name][raw] === undefined) continue
    const f = median(results[name][framework].map((r) => r.rps))
    const r = median(results[name][raw].map((x) => x.rps))
    layerRows.push(
      `| ${name} | ${label} | ${Math.round(f)} | ${Math.round(r)} | ${(f / r).toFixed(3)} |`,
    )
  }
}
const table = `${rows.join("\n")}\n\n${layerRows.join("\n")}`
console.log(table)
writeFileSync(
  join(out, "engine-compare.json"),
  JSON.stringify({ rounds, duration, targets, pin, results }, null, 2),
)
writeFileSync(join(out, "engine-compare.md"), `${table}\n`)
if (env.GITHUB_STEP_SUMMARY)
  appendFileSync(env.GITHUB_STEP_SUMMARY, `## Engine compare\n\n${table}\n`)

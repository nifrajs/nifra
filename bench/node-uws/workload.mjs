// bun build workload-serve.mjs --target node --external uWebSockets.js --outfile dist/workload-serve.mjs
// node workload.mjs [rounds] [seconds] [connections] [arm,arm,...]   arms: raw | declarative | nifra | label=path/to/serve.mjs
// Interleaved oha runs of the web-frameworks-benchmark workload; prints median rps per arm and route.
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const rounds = Number(process.argv[2] ?? 3)
const secs = Number(process.argv[3] ?? 4)
const conns = Number(process.argv[4] ?? 64)
const armNames = (process.argv[5] ?? "raw,declarative,nifra").split(",")
const dir = fileURLToPath(new URL(".", import.meta.url))
const routes = [
  { name: "GET /", args: [], path: "/" },
  { name: "GET /user/:id", args: [], path: "/user/1234567890" },
  { name: "POST /user", args: ["-m", "POST", "-d", "x"], path: "/user" },
]

const start = async (arm, port) => {
  const [label, file] = arm.includes("=") ? arm.split("=") : [arm, undefined]
  const child = spawn(
    process.execPath,
    file ? [file, port] : [`${dir}dist/workload-serve.mjs`, label, port],
    {
      stdio: "ignore",
      env: { ...process.env, NODE_PATH: `${dir}../../packages/node-uws/node_modules` },
    },
  )
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).status === 200) return child
    } catch {}
  }
  child.kill()
  throw new Error(`${arm} did not start`)
}

const oha = (port, route) => {
  const out = execFileSync(
    "oha",
    [
      "-z",
      `${secs}s`,
      "-c",
      String(conns),
      "--no-tui",
      "--output-format",
      "json",
      ...route.args,
      `http://127.0.0.1:${port}${route.path}`,
    ],
    { encoding: "utf8" },
  )
  const json = JSON.parse(out)
  return json.summary.requestsPerSec
}

const samples = {}
for (let round = 0; round < rounds; round++) {
  for (const [i, arm] of armNames.entries()) {
    const port = 4800 + i
    const child = await start(arm, port)
    for (const route of routes) {
      const key = `${arm}|${route.name}`
      if (!samples[key]) samples[key] = []
      samples[key].push(oha(port, route))
    }
    child.kill("SIGKILL")
    await new Promise((r) => setTimeout(r, 300))
  }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
for (const route of routes) {
  console.log(route.name)
  for (const arm of armNames) {
    const xs = samples[`${arm}|${route.name}`]
    console.log(
      `  ${arm.padEnd(14)} ${Math.round(median(xs)).toString().padStart(8)} rps  (${xs.map((x) => Math.round(x / 1000)).join(", ")}k)`,
    )
  }
}

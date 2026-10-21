import { execFileSync, fork, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { cpus, platform, release } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseOha, summarize } from "./measurements.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
function packageVersion(name) {
  let directory = dirname(createRequire(import.meta.url).resolve(name))
  while (directory !== dirname(directory)) {
    const manifest = resolve(directory, "package.json")
    if (existsSync(manifest)) {
      const data = JSON.parse(readFileSync(manifest, "utf8"))
      if (data.name === name && typeof data.version === "string") return data.version
    }
    directory = dirname(directory)
  }
  throw new Error(`package version not found: ${name}`)
}
function workspaceArtifactHash() {
  const hash = createHash("sha256")
  for (const folder of ["packages/core/dist", "packages/node/dist", "packages/middleware/dist"]) {
    for (const name of readdirSync(resolve(root, folder), { recursive: true })
      .filter((file) => file.endsWith(".js"))
      .sort()) {
      hash.update(`${folder}/${name}`)
      hash.update(readFileSync(resolve(root, folder, name)))
    }
  }
  return hash.digest("hex")
}
const option = (key, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${key}=`))
    ?.split("=")
    .slice(1)
    .join("=") ?? fallback
const integer = (key, fallback) => {
  const n = Number(option(key, String(fallback)))
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${key} must be a positive integer`)
  return n
}
const suite = option("suite", "realworld")
const mode = option("mode", "metrics")
const packaging = option("packaging", mode === "memory" ? "native" : "bundled-nifra")
const requests = integer("requests", 100000)
const warmup = integer("warmup", 20000)
const connections = integer("connections", 50)
const out = resolve(option("out", "bench/profiling/results"))
if (!["realworld", "worst", "generic"].includes(suite)) throw new Error("unknown suite")
if (!["metrics", "cpu", "heap", "memory"].includes(mode)) throw new Error("unknown mode")
if (!["native", "bundled-nifra"].includes(packaging)) throw new Error("unknown packaging")
if (mode === "memory" && suite !== "realworld")
  throw new Error("memory publication uses the real-world fixture")
await mkdir(out, { recursive: true })

const worst = suite !== "realworld"
const source = worst
  ? "bench/http/worst-case/serve-node-nifra-worst.ts"
  : "bench/http-realworld/serve-node-nifra.ts"
execFileSync("bun", ["build", source, "--target=node", `--outdir=${out}`], {
  cwd: root,
  stdio: "ignore",
})
const nifraBundle = resolve(out, source.split("/").at(-1).replace(/\.ts$/, ".js"))
let targets = [
  { name: "nifra", file: packaging === "native" ? source : nifraBundle, args: [] },
  {
    name: "fastify",
    file: worst
      ? "bench/http/worst-case/serve-node-fastify.ts"
      : "bench/http-realworld/serve-node.ts",
    args: worst ? [] : ["fastify"],
  },
  {
    name: "elysia",
    file: worst
      ? "bench/http/worst-case/serve-node-elysia.ts"
      : "bench/http-realworld/serve-node.ts",
    args: worst ? [] : ["elysia"],
  },
]
if (mode === "memory") {
  for (const name of ["hono", "express"])
    targets.push({ name, file: "bench/http-realworld/serve-node.ts", args: [name] })
}
const baseline = option("baseline", "")
if (baseline) targets.push({ name: "nifra-before", file: resolve(baseline), args: [] })
const selected = option("targets", "").split(",").filter(Boolean)
if (selected.length > 0) {
  if (selected.some((name) => !targets.some((target) => target.name === name)))
    throw new Error("unknown target")
  targets = targets.filter((target) => selected.includes(target.name))
}
const rounds = integer("rounds", mode === "memory" ? targets.length : targets.length * 2)
const auth = {
  authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
  cookie: "theme=dark",
  origin: "https://app.example.com",
  "x-request-id": "bench-1",
}
const items = (n) =>
  Array.from({ length: n }, (_, i) => ({
    title: `task-${i}`,
    done: i % 2 === 0,
    priority: i % 5,
    notes: "x".repeat(64),
  }))
const availableWorkloads = worst
  ? [
      {
        name: "get",
        path: "/orgs/acme/projects/apollo/tasks/42?verbose=1&trace=abc123",
        headers: { "x-req-id": "bench-1" },
      },
      {
        name: "post-11kb",
        path: "/orgs/acme/projects/apollo/tasks",
        headers: { "content-type": "application/json", "x-req-id": "bench-1" },
        body: JSON.stringify({ items: items(88) }),
      },
      {
        name: "post-69kb",
        path: "/orgs/acme/projects/apollo/tasks",
        headers: { "content-type": "application/json", "x-req-id": "bench-1" },
        body: JSON.stringify({ items: items(560) }),
      },
    ]
  : [
      { name: "get", path: "/api/orders?limit=10", headers: auth },
      {
        name: "post",
        path: "/api/orders",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ sku: "SKU-1", qty: 2, note: "gift wrap" }),
      },
    ]
const selectedWorkloads = option("workloads", "").split(",").filter(Boolean)
if (mode === "memory" && selectedWorkloads.length > 0)
  throw new Error("memory publication requires every workload")
if (
  selectedWorkloads.some((name) => !availableWorkloads.some((workload) => workload.name === name))
)
  throw new Error("unknown workload")
const workloads = selectedWorkloads.length
  ? availableWorkloads.filter((workload) => selectedWorkloads.includes(workload.name))
  : availableWorkloads

function load(base, workload, count) {
  return new Promise((accept, reject) => {
    const args = [
      "--no-tui",
      "--output-format",
      "json",
      "-n",
      String(count),
      "-c",
      String(connections),
    ]
    for (const [key, value] of Object.entries(workload.headers)) args.push("-H", `${key}: ${value}`)
    if (workload.body) args.push("-m", "POST", "-d", workload.body)
    args.push(`${base}${workload.path}`)
    const proc = spawn("oha", args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "",
      stderr = ""
    proc.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    proc.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`oha exited ${code}: ${stderr}`))
      try {
        accept(parseOha(stdout, count))
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function ready(child, base) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`server exited ${child.exitCode ?? child.signalCode}`)
    try {
      const workload = workloads[0]
      const r = await fetch(`${base}${workload.path}`, {
        method: workload.body ? "POST" : "GET",
        headers: workload.headers,
        body: workload.body,
      })
      if (r.status === 200) {
        await r.text()
        return
      }
      await r.text()
    } catch (error) {
      if (i === 99) throw error
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("server readiness timed out")
}

let id = 0
function control(child, action) {
  return new Promise((accept, reject) => {
    const requestId = ++id
    const timeout = setTimeout(() => finish(new Error("profiler control timed out")), 30000)
    const listener = (message) => {
      if (message?.type !== "profile" || message.id !== requestId) return
      finish(message.error ? new Error(message.error) : null, message.result)
    }
    function finish(error, value) {
      clearTimeout(timeout)
      child.off("message", listener)
      if (error) reject(error)
      else accept(value)
    }
    child.on("message", listener)
    child.send({ type: "profile", id: requestId, action, mode })
  })
}

const running = []
const samples = []
const meta = {
  suite,
  mode,
  packaging,
  completed: false,
  workspaceArtifactSHA256: mode === "memory" ? workspaceArtifactHash() : undefined,
  rounds,
  requests,
  warmupRequests: mode === "memory" ? 0 : Math.min(requests, warmup),
  connections,
  workloads: workloads.map((workload) => workload.name),
  node: process.version,
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  versions: Object.fromEntries(
    ["@nifrajs/core", "fastify", "elysia", "@elysiajs/node", "hono", "express"].map((name) => [
      name,
      packageVersion(name),
    ]),
  ),
  nifraBundleSHA256: createHash("sha256")
    .update(await readFile(nifraBundle))
    .digest("hex"),
  date: new Date().toISOString(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
}
function startTarget(target, i) {
  const port = 3820 + i
  const child = fork(resolve(root, target.file), [...target.args, String(port)], {
    cwd: root,
    execPath: process.execPath,
    execArgv: ["--expose-gc", "--import", resolve(root, "bench/profiling/node-probe.mjs")],
    env: { ...process.env, BENCH_GENERIC: suite === "generic" ? "1" : "0" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  })
  return { ...target, child, base: `http://127.0.0.1:${port}` }
}
function stopTarget({ child }) {
  return new Promise((accept) => {
    if (child.exitCode !== null || child.signalCode !== null) return accept()
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000)
    child.once("exit", () => {
      clearTimeout(timeout)
      accept()
    })
    child.kill()
  })
}
async function probeTarget(server) {
  for (const w of workloads) {
    const response = await fetch(`${server.base}${w.path}`, {
      method: w.body ? "POST" : "GET",
      headers: w.headers,
      body: w.body,
    })
    const body = await response.json()
    if (response.headers.get("x-request-id") !== "bench-1") {
      throw new Error(`${server.name}/${w.name}: missing request-id header`)
    }
    if (
      response.status !== 200 ||
      (worst
        ? body.org !== "acme" ||
          (w.body ? body.count !== JSON.parse(w.body).items.length : body.id !== "42")
        : w.body
          ? body.id !== "ord_new"
          : body.orders?.length !== 10)
    )
      throw new Error(`${server.name}/${w.name}: invalid response`)
  }
}
if (mode === "memory") {
  for (let round = 0; round < rounds; round++) {
    const order = [
      ...targets.slice(round % targets.length),
      ...targets.slice(0, round % targets.length),
    ]
    for (const target of order) {
      const server = startTarget(target, 0)
      try {
        await ready(server.child, server.base)
        await probeTarget(server)
        const snapshots = { ready: await control(server.child, "snapshot") }
        for (const workload of workloads) {
          await load(server.base, workload, requests)
          snapshots[workload.name] = await control(server.child, "snapshot")
        }
        samples.push({ target: target.name, round, snapshots })
        await writeFile(
          resolve(out, `${suite}-${mode}.json`),
          JSON.stringify({ meta, samples }, null, 2),
        )
        console.error(
          `memory round ${round} ${target.name}: ${(snapshots.post.rss / 1048576).toFixed(1)} MiB RSS after POST`,
        )
      } finally {
        await stopTarget(server)
      }
    }
  }
  if (workspaceArtifactHash() !== meta.workspaceArtifactSHA256)
    throw new Error("workspace artifacts changed during memory capture")
  meta.completed = true
  await writeFile(resolve(out, `${suite}-${mode}.json`), JSON.stringify({ meta, samples }, null, 2))
} else
  try {
    for (let i = 0; i < targets.length; i++) {
      const server = startTarget(targets[i], i)
      running.push(server)
      await ready(server.child, server.base)
      await probeTarget(server)
      for (const w of workloads) await load(server.base, w, Math.min(requests, warmup))
    }
    for (const workload of workloads) {
      for (let round = 0; round < rounds; round++) {
        const rotated = [
          ...running.slice(round % running.length),
          ...running.slice(0, round % running.length),
        ]
        const order = Math.floor(round / running.length) % 2 ? rotated.reverse() : rotated
        for (const target of order) {
          await control(target.child, "start")
          const timing = await load(target.base, workload, requests)
          const measurement = await control(target.child, "stop")
          const summary = summarize(measurement.profile, mode)
          if (measurement.profile)
            await writeFile(
              resolve(
                out,
                `${suite}-${mode}-${target.name}-${workload.name}-${round}.${mode === "cpu" ? "cpuprofile" : "heapprofile"}`,
              ),
              JSON.stringify(measurement.profile),
            )
          delete measurement.profile
          const sample = {
            target: target.name,
            workload: workload.name,
            round,
            ...timing,
            ...measurement,
            userUsPerRequest: measurement.cpu.user / requests,
            systemUsPerRequest: measurement.cpu.system / requests,
            cpuUsPerRequest: (measurement.cpu.user + measurement.cpu.system) / requests,
            allocatedBytesPerRequest: mode === "heap" ? summary.total / requests : undefined,
            summary,
          }
          samples.push(sample)
          console.error(
            `${suite}/${mode} ${workload.name} round ${round} ${target.name}: ${timing.rps.toFixed(0)} rps, ${sample.cpuUsPerRequest.toFixed(2)} CPU us/req${sample.allocatedBytesPerRequest ? `, ${sample.allocatedBytesPerRequest.toFixed(0)} sampled B/req` : ""}`,
          )
          await writeFile(
            resolve(out, `${suite}-${mode}.json`),
            JSON.stringify({ meta, samples }, null, 2),
          )
        }
      }
    }
  } finally {
    await Promise.all(running.map(stopTarget))
  }
if (mode !== "memory") {
  meta.completed = true
  await writeFile(resolve(out, `${suite}-${mode}.json`), JSON.stringify({ meta, samples }, null, 2))
}
console.log(resolve(out, `${suite}-${mode}.json`))

// TEMPORARY - delete with .github/workflows/bench-ab.yml before the PR merges.
// CPU time per request, base tree vs head tree, on one Linux runner: each sample is two fresh server
// processes under load, N1 and N2 requests, (cpu2 - cpu1) / (N2 - N1), so startup and warmup cancel.
// Arms rotate every round; `base2` is a second run of the base tree, the A/A control for the noise floor.
//   TREES=base=./base,head=./head ROUNDS=8 bun bench/ab-tmp/ab.ts [workload filter]

import { readdirSync, readFileSync } from "node:fs"
import { $ } from "bun"

const H = import.meta.dir
const ROUNDS = Number(process.env.ROUNDS ?? "8")
const trees = new Map<string, string>()
for (const pair of (process.env.TREES ?? "").split(",")) {
  const [name = "", path = ""] = pair.split("=")
  trees.set(name, path)
}
const tree = (arm: string): string =>
  `${process.cwd()}/${trees.get(arm === "base2" ? "base" : arm)}`
const ARMS = ["base", "head", "base2"]
const SERVER_CPUS = "0"
const CLIENT_CPUS = "2,3"

const RW = [
  "-H",
  "authorization: Bearer abcdefghijklmnopqrstuvwxyz",
  "-H",
  "cookie: theme=dark",
  "-H",
  "origin: https://app.example.com",
]
const JSONH = ["-H", "content-type: application/json"]
type W = {
  name: string
  cmd: (t: string, port: number) => string[]
  path: string
  args: string[]
  n: [number, number]
}
const bun =
  (mod: string, ...a: string[]) =>
  (t: string, port: number) => ["bun", `${H}/wrap-bun.ts`, `${t}/${mod}`, ...a, String(port)]
const node =
  (mod: string, ...a: string[]) =>
  (t: string, port: number) => ["node", `${H}/wrap.mjs`, `${t}/${mod}`, String(port), ...a]
const N: [number, number] = [5_000, 25_000]
const ORDER = { sku: "SKU-1", qty: 2, note: "gift wrap" }
const WORK: W[] = [
  {
    name: "bun http GET /users/:id",
    cmd: bun("bench/http/serve.ts", "nifra"),
    path: "/users/123",
    args: [],
    n: N,
  },
  {
    name: "bun rw GET /api/orders",
    cmd: bun("bench/http-realworld/serve.ts", "nifra"),
    path: "/api/orders?limit=10",
    args: RW,
    n: N,
  },
  {
    name: "bun rw POST /api/orders",
    cmd: bun("bench/http-realworld/serve.ts", "nifra"),
    path: "/api/orders",
    args: [...RW, "-m", "POST", "-d", JSON.stringify(ORDER), ...JSONH],
    n: N,
  },
  {
    name: "bun rw GET body-hash",
    cmd: bun("bench/http-realworld/serve.ts", "nifra-body"),
    path: "/api/orders?limit=10",
    args: RW,
    n: N,
  },
  {
    name: "node http GET /users/:id",
    cmd: node("bench/http/dist/serve-node-nifra.js"),
    path: "/users/123",
    args: [],
    n: N,
  },
  {
    name: "node rw GET /api/orders",
    cmd: node("bench/http-realworld/dist/serve-node-nifra.js"),
    path: "/api/orders?limit=10",
    args: RW,
    n: N,
  },
  {
    name: "node rw POST /api/orders",
    cmd: node("bench/http-realworld/dist/serve-node-nifra.js"),
    path: "/api/orders",
    args: [...RW, "-m", "POST", "-d", JSON.stringify(ORDER), ...JSONH],
    n: N,
  },
  {
    name: "node rw GET body-hash",
    cmd: node("bench/http-realworld/dist/serve-node-nifra.js", "body"),
    path: "/api/orders?limit=10",
    args: RW,
    n: N,
  },
]
const filter = process.argv[2]
const work = filter ? WORK.filter((w) => filter.split(",").some((f) => w.name.includes(f))) : WORK

// On-CPU nanoseconds of every thread of `pid`: the scheduler's own account, not 10 ms clock ticks.
function cpuNs(pid: number): number {
  let total = 0
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    total += Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").split(" ")[0])
  }
  return total
}

let port = Number(process.env.PORT0 ?? "21000")
const answers = async (p: number): Promise<boolean> => {
  try {
    await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(300) })
    return true
  } catch {
    return false
  }
}

async function sample(w: W, arm: string, n: number): Promise<number> {
  port += 2
  const proc = Bun.spawn(["taskset", "-c", SERVER_CPUS, ...w.cmd(tree(arm), port)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
  })
  const deadline = Date.now() + 60_000
  while (!(await answers(port + 1))) {
    if (proc.exitCode !== null || Date.now() > deadline) {
      proc.kill()
      throw new Error(
        `${w.name} ${arm} did not start: ${(await new Response(proc.stderr).text()).slice(-800)}`,
      )
    }
    await Bun.sleep(50)
  }
  while (!(await answers(port))) await Bun.sleep(50)
  const out =
    await $`taskset -c ${CLIENT_CPUS} oha -n ${n} -c 50 --no-tui --output-format json ${w.args} http://127.0.0.1:${port}${w.path}`
      .quiet()
      .text()
  const codes = JSON.parse(out).statusCodeDistribution ?? {}
  const ok = (codes["200"] ?? 0) + (codes["201"] ?? 0)
  const cpu = cpuNs(proc.pid)
  await fetch(`http://127.0.0.1:${port + 1}/exit`).catch(() => {})
  await proc.exited
  if (ok !== n) throw new Error(`${w.name} ${arm}: ${JSON.stringify(codes)} of ${n}`)
  return cpu
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const k = s.length >> 1
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2
}

const rows: string[] = []
for (const w of work) {
  const per: Record<string, number[]> = Object.fromEntries(ARMS.map((a) => [a, []]))
  for (let r = 0; r < ROUNDS; r++) {
    for (const arm of ARMS.map((_, i) => ARMS[(i + r) % ARMS.length]!)) {
      const low = await sample(w, arm, w.n[0])
      const high = await sample(w, arm, w.n[1])
      per[arm]!.push((high - low) / (w.n[1] - w.n[0]))
    }
  }
  const base = per.base!
  const ratios = (arm: string): number[] => per[arm]!.map((v, i) => v / base[i]!)
  const cell = (arm: string): string => {
    const rs = ratios(arm)
    return `${median(rs).toFixed(3)} (${Math.min(...rs).toFixed(3)}-${Math.max(...rs).toFixed(3)})`
  }
  const line = `| ${w.name} | ${Math.round(median(base))} ns | ${cell("head")} | ${cell("base2")} |`
  console.log(line)
  rows.push(line)
}
const header = [
  "| workload | base cpu/request | head / base, median (range) | base2 / base (A/A) |",
  "|---|---|---|---|",
]
const table = [...header, ...rows].join("\n")
await Bun.write(
  process.env.AB_OUT ?? "ab-result.md",
  `${table}\n\nrounds: ${ROUNDS}, requests per sample: ${N.join(" -> ")}, server on cpu ${SERVER_CPUS}, oha on ${CLIENT_CPUS}\n`,
)

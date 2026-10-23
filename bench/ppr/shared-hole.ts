/**
 * What a shared hole's hit costs: S1's product page with its related list in the shell (`/ppr/1`)
 * against the same page with that list as a shared hole (`/ppr-shared/1`), both cached. Measured in
 * process, so the difference is the server's own work and no socket's, as the process CPU over
 * `BATCH` requests with `CONC` in flight. Rounds run the variants interleaved, in an order reversed
 * every other round, beside an A/A control: the shell variant against itself. Gate: the median added
 * CPU per request under 0.1 ms. React only: a hit renders nothing, so no framework code runs on it.
 * Run: `bun bench/ppr/shared-hole.ts`; it exits 1 when the gate fails.
 */
import { join } from "node:path"

// Bun picks the JSX runtime when the process starts, so production must be set before it does.
if (process.env.NODE_ENV !== "production") {
  const child = Bun.spawn(["bun", import.meta.path], {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["inherit", "inherit", "inherit"],
  })
  process.exit(await child.exited)
}

const CONC = 1_024
const BATCH = 4_000
const ROUNDS = 7
const GATE_US = 100

const upstream = Bun.spawn(["bun", join(import.meta.dir, "upstream.ts")], {
  stdout: "pipe",
  stderr: "inherit",
})
let announced = ""
const reader = upstream.stdout.getReader()
while (!/on (http:\/\/\S+)/.test(announced)) {
  const { value, done } = await reader.read()
  if (done) throw new Error(`the catalog process exited: ${announced}`)
  announced += new TextDecoder().decode(value)
}
reader.releaseLock()

process.env.FRAMEWORK = "react"
process.env.PPR_UPSTREAM = (/on (http:\/\/\S+)/.exec(announced)?.[1] ?? "").replace(/\/$/, "")
const { app } = await import("./app.ts")

const visit = async (path: string): Promise<void> => {
  const response = await app.fetch(
    new Request(`http://bench.local${path}`, { headers: { cookie: "user=ada" } }),
  )
  if (response.status !== 200) throw new Error(`${path}: ${response.status}`)
  await response.text()
}

/** CPU microseconds per request over one batch. */
async function batch(path: string): Promise<number> {
  let issued = 0
  const worker = async (): Promise<void> => {
    while (issued < BATCH) {
      issued++
      await visit(path)
    }
  }
  const before = process.cpuUsage()
  await Promise.all(Array.from({ length: CONC }, worker))
  const used = process.cpuUsage(before)
  return (used.user + used.system) / BATCH
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN

const SHELL = "/ppr/1?scale=1"
const SHARED = "/ppr-shared/1?scale=1"
try {
  // Builds both shells and the shared entry, then one unrecorded batch each.
  await visit(SHELL)
  await visit(SHARED)
  const shared = await (await app.fetch(new Request(`http://bench.local${SHARED}`))).text()
  if (!shared.includes('"shared":["related"]') || shared.includes('"error":true')) {
    throw new Error("the shared hole did not serve its entry")
  }
  await batch(SHELL)
  await batch(SHARED)
  const added: number[] = []
  const control: number[] = []
  const base: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    // The two shell batches swap places each round, so neither A/A side is always the later one.
    const order = round % 2 === 0 ? ["a", "shared", "a2"] : ["a2", "shared", "a"]
    const us: Record<string, number> = {}
    for (const name of order) us[name] = await batch(name === "shared" ? SHARED : SHELL)
    const a = us.a ?? Number.NaN
    const a2 = us.a2 ?? Number.NaN
    added.push((us.shared ?? Number.NaN) - (a + a2) / 2)
    control.push(a2 - a)
    base.push(a, a2)
  }
  const gate = median(added)
  console.log("\n## Shared hole hit: S1 with the related list in the shell vs as a shared hole\n")
  console.log(`| variant | CPU per request, median of ${ROUNDS} rounds | range |`)
  console.log("|---|---|---|")
  console.log(
    `| react cached PPR, related list in the shell | ${median(base).toFixed(1)} us | ${Math.min(...base).toFixed(1)} to ${Math.max(...base).toFixed(1)} us |`,
  )
  console.log(
    `| react shared hole hit, added | ${gate.toFixed(1)} us | ${Math.min(...added).toFixed(1)} to ${Math.max(...added).toFixed(1)} us |`,
  )
  console.log(
    `| react A/A control | ${median(control).toFixed(1)} us | ${Math.min(...control).toFixed(1)} to ${Math.max(...control).toFixed(1)} us |`,
  )
  console.log(`(in process, ${CONC} in flight, ${BATCH} requests per batch)`)
  const ok = gate < GATE_US
  console.log(
    `${ok ? "PASS" : "FAIL"} react: a shared hole hit adds ${gate.toFixed(1)} us CPU per request (gate ${GATE_US} us)`,
  )
  if (!ok) process.exitCode = 1
} finally {
  upstream.kill()
}

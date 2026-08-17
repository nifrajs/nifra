/**
 * Focused A/B: nifra echo per-message cost vs the raw-Bun ceiling, interleaved to cancel machine
 * drift. Spawns both servers once, then alternates trials (raw, nifra, raw, nifra, ...) so a thermal
 * or scheduler excursion hits both equally; reports the median over trials, which the single-run
 * cross-framework table cannot (one shot per framework there). Not a CI gate - a hand tool.
 *   bun run bench/realtime/_ab-echo.ts [trials] [msgsPerTrial]
 */
import { echoRtt } from "./driver.ts"

const HERE = new URL(".", import.meta.url).pathname
const TRIALS = Number(process.argv[2] ?? "15")
const MSGS = Number(process.argv[3] ?? "60000")

async function waitReady(proc: Bun.Subprocess): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) throw new Error("server exited before READY")
    buf += dec.decode(value, { stream: true })
    if (buf.includes("READY")) return reader.releaseLock()
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}

const spawn = (file: string, port: number): Bun.Subprocess =>
  Bun.spawn(["bun", `${HERE}${file}`, String(port)], { stdout: "pipe", stderr: "pipe" })

const raw = spawn("serve-bun.ts", 42_100)
const nif = spawn("serve-nifra.ts", 42_101)
await Promise.all([waitReady(raw), waitReady(nif)])
await Bun.sleep(300)

// Warm both JITs, discarded.
await echoRtt("ws://localhost:42100/echo", 8_000).catch(() => undefined)
await echoRtt("ws://localhost:42101/echo", 8_000).catch(() => undefined)

const rawTp: number[] = []
const nifTp: number[] = []
const rawP50: number[] = []
const nifP50: number[] = []
for (let i = 0; i < TRIALS; i++) {
  const r = await echoRtt("ws://localhost:42100/echo", MSGS)
  const n = await echoRtt("ws://localhost:42101/echo", MSGS)
  rawTp.push(r.msgPerSec)
  nifTp.push(n.msgPerSec)
  rawP50.push(r.p50)
  nifP50.push(n.p50)
  process.stdout.write(".")
}
raw.kill()
nif.kill()
await Promise.all([raw.exited, nif.exited])

const rTp = median(rawTp)
const nTp = median(nifTp)
console.log(
  `\n\nA/B echo · ${TRIALS} interleaved trials × ${MSGS.toLocaleString()} msgs · bun ${Bun.version}\n`,
)
console.log(`             median msg/s     median p50`)
console.log(
  `  bun-raw    ${Math.round(rTp).toLocaleString().padStart(12)}     ${median(rawP50).toFixed(3)}ms`,
)
console.log(
  `  nifra      ${Math.round(nTp).toLocaleString().padStart(12)}     ${median(nifP50).toFixed(3)}ms`,
)
console.log(`\n  nifra / raw throughput: ${(nTp / rTp).toFixed(3)}×`)
process.exit(0)

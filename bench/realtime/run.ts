/**
 * Cross-framework realtime bench: WebSocket echo RTT, WebSocket broadcast fan-out, and SSE
 * throughput, one framework at a time on the Bun runtime (native WS + native pub/sub - the fair
 * common substrate; fastify/express have no first-class Bun WS and are Node-only, so they are out of
 * this comparison by design). Each target serves the same contract (see driver.ts); the runner
 * spawns it, waits for READY, drives the three measurements, kills it, and prints ratio tables
 * against the raw-Bun baseline. Ratios on one run are the signal; absolutes are box-specific.
 *
 *   bun run bench/realtime/run.ts            # full
 *   bun run bench/realtime/run.ts --quick    # lighter counts
 */
import {
  type EchoResult,
  echoRtt,
  type FanOutResult,
  fanOut,
  type SseResult,
  sseThroughput,
} from "./driver.ts"

const QUICK = process.argv.includes("--quick")
const ECHO_MSGS = QUICK ? 40_000 : 100_000
const SSE_EVENTS = QUICK ? 80_000 : 200_000
const FANOUT_SUBS = QUICK ? 200 : 500
const FANOUT_PUB = 20

type Target = { name: string; file: string }
const TARGETS: readonly Target[] = [
  { name: "bun-raw", file: "serve-bun.ts" },
  { name: "nifra", file: "serve-nifra.ts" },
  { name: "elysia", file: "serve-elysia.ts" },
  { name: "hono", file: "serve-hono.ts" },
]

type Row = {
  name: string
  echo?: EchoResult
  fan?: FanOutResult
  sse?: SseResult
  error?: string
  fanError?: string
}

const HERE = new URL(".", import.meta.url).pathname

async function waitReady(proc: Bun.Subprocess, timeoutMs = 15_000): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let buf = ""
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) throw new Error("server exited before READY")
    buf += dec.decode(value, { stream: true })
    if (buf.includes("READY")) {
      reader.releaseLock()
      return
    }
  }
  throw new Error("timed out waiting for READY")
}

async function measure(target: Target, port: number): Promise<Row> {
  const proc = Bun.spawn(["bun", `${HERE}${target.file}`, String(port)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const row: Row = { name: target.name }
  try {
    await waitReady(proc)
    await Bun.sleep(200)
    const base = `http://localhost:${port}`
    // JIT warmup (discarded) so the measured echo run reflects steady state.
    await echoRtt(`ws://localhost:${port}/echo`, 8_000).catch(() => undefined)
    // Each lane is isolated: a fan-out integrity void never voids echo or SSE.
    row.echo = await echoRtt(`ws://localhost:${port}/echo`, ECHO_MSGS)
    const fan = await fanOut(base, `ws://localhost:${port}/room`, FANOUT_SUBS, FANOUT_PUB).catch(
      (e) => {
        row.fanError = e instanceof Error ? e.message : String(e)
        return undefined
      },
    )
    if (fan !== undefined) row.fan = fan
    row.sse = await sseThroughput(base, SSE_EVENTS)
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e)
  } finally {
    proc.kill()
    await proc.exited
  }
  return row
}

function table(
  rows: Row[],
  title: string,
  pick: (r: Row) => number | undefined,
  unit: string,
  fmt: (r: Row) => string,
): void {
  const ref = rows.find((r) => r.name === "bun-raw") ?? rows[0]
  const baseline = ref ? pick(ref) : undefined
  console.log(`\n### ${title}\n`)
  const ranked = [...rows].sort((a, b) => (pick(b) ?? -1) - (pick(a) ?? -1))
  console.log(`  framework      ${unit.padStart(14)}   ×raw   detail`)
  console.log(`  ${"-".repeat(78)}`)
  for (const r of ranked) {
    const v = pick(r)
    if (v === undefined) {
      const why = title.startsWith("WebSocket fan-out")
        ? (r.fanError ?? r.error ?? "")
        : (r.error ?? "")
      console.log(`  ${r.name.padEnd(12)}   ${"VOID".padStart(14)}   ----   ${why}`)
      continue
    }
    const ratio = baseline ? v / baseline : 1
    const star = r.name === "nifra" ? " ★" : ""
    console.log(
      `  ${r.name.padEnd(12)}   ${Math.round(v).toLocaleString().padStart(14)}   ${ratio.toFixed(2)}   ${fmt(r)}${star}`,
    )
  }
}

console.log(`\nRealtime cross-framework bench · bun ${Bun.version} · ${QUICK ? "quick" : "full"}`)
console.log(
  `WS echo ${ECHO_MSGS.toLocaleString()} msgs · fan-out ${FANOUT_SUBS}×${FANOUT_PUB} · SSE ${SSE_EVENTS.toLocaleString()} events`,
)

const rows: Row[] = []
let port = 41_000
for (const target of TARGETS) {
  process.stdout.write(`\n· ${target.name} …`)
  rows.push(await measure(target, port++))
  process.stdout.write(" done")
}
console.log("")

table(
  rows,
  "WebSocket echo — round-trip throughput",
  (r) => r.echo?.msgPerSec,
  "msg/s",
  (r) => (r.echo ? `p50 ${r.echo.p50.toFixed(3)}ms  p99 ${r.echo.p99.toFixed(3)}ms` : ""),
)
table(
  rows,
  "WebSocket fan-out — server-side broadcast cost",
  (r) => r.fan?.delPerSec,
  "deliveries/s",
  (r) =>
    r.fan
      ? `${r.fan.perPublishMs.toFixed(3)}ms/publish → ${r.fan.subs} subs · ${r.fan.delivered}/${r.fan.expected} ok`
      : "",
)
table(
  rows,
  "SSE — server-push throughput",
  (r) => r.sse?.evPerSec,
  "events/s",
  (r) => (r.sse ? `${r.sse.mib.toFixed(1)}MB in ${r.sse.secs.toFixed(2)}s` : ""),
)
console.log("")
process.exit(0)

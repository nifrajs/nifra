/**
 * Load driver for the realtime (WS + SSE) cross-framework bench. Runtime-neutral: uses the global
 * `WebSocket` client and `fetch`, so it drives any server that speaks the shared contract:
 *   WS  /echo         - echoes each frame back verbatim
 *   WS  /room         - subscribes the connection to topic "room" on open
 *   GET /fire?p=N     - publishes N frames to "room" (broadcast fan-out)
 *   GET /feed?n=N     - an SSE stream of N typed events, then closes
 *
 * One connection/stream per measurement, one framework at a time (the runner never overlaps servers),
 * so the numbers are contention-free and the ratios across rows are the signal.
 */
export type EchoResult = { msgPerSec: number; p50: number; p99: number; msgs: number }
export type FanOutResult = {
  delPerSec: number
  serverMs: number
  perPublishMs: number
  subs: number
  publishes: number
  delivered: number
  expected: number
}
export type SseResult = { evPerSec: number; mib: number; secs: number; events: number }

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) =>
      reject(new Error(`ws open failed: ${url} (${String((e as ErrorEvent).message ?? e)})`))
  })

/** Echo round-trip throughput: keep `window` frames in flight, FIFO-pair the ordered replies. */
export async function echoRtt(wsUrl: string, total = 100_000, window = 32): Promise<EchoResult> {
  const rtt: number[] = []
  const sentAt: number[] = new Array(total)
  let sent = 0
  let recv = 0
  const ws = await openSocket(wsUrl)
  const started = performance.now()
  await new Promise<void>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`echo stalled at ${recv}/${total}`)), 30_000)
    const pump = () => {
      while (sent < total && sent - recv < window) {
        sentAt[sent] = performance.now()
        ws.send("ping")
        sent++
      }
    }
    ws.onmessage = () => {
      rtt.push(performance.now() - (sentAt[recv] ?? started))
      recv++
      if (recv >= total) {
        clearTimeout(guard)
        return resolve()
      }
      pump()
    }
    pump()
  })
  const secs = (performance.now() - started) / 1000
  ws.close()
  rtt.sort((a, b) => a - b)
  return { msgPerSec: total / secs, p50: pct(rtt, 50), p99: pct(rtt, 99), msgs: total }
}

/**
 * Broadcast fan-out: N subscribers, P publishes -> N*P deliveries.
 *
 * The rate is **server-authoritative**: the `/fire` handler times its own publish loop and returns
 * the ms, so the reported cost is the framework's broadcast API alone - not the single client event
 * loop draining N*P `onmessage` callbacks, which is identical work for every target and would drown
 * the signal. Client receipt is kept only as an *exact-count* integrity gate: every subscriber must
 * receive exactly `publishes` frames (no drops, no double-subscription inflation) or the row is void.
 */
export async function fanOut(
  baseUrl: string,
  wsRoom: string,
  subs = 500,
  publishes = 20,
): Promise<FanOutResult> {
  const expected = subs * publishes
  let got = 0
  const clients = await Promise.all(
    Array.from({ length: subs }, async () => {
      const ws = await openSocket(wsRoom)
      ws.onmessage = () => {
        got++
      }
      return ws
    }),
  )
  await Bun.sleep(150) // let every subscription settle before the first publish
  const res = await fetch(`${baseUrl}/fire?p=${publishes}`)
  const body = (await res.json()) as { fired: number; ms: number }
  // Drain: wait until deliveries stop climbing for a full quiet window, then assert the exact count.
  let last = -1
  let stable = 0
  while (stable < 5) {
    await Bun.sleep(20)
    if (got === last) stable++
    else {
      stable = 0
      last = got
    }
    if (got >= expected) break
  }
  await Bun.sleep(50) // final settle to catch any late stragglers before the exact-count assertion
  for (const ws of clients) ws.close()
  if (got !== expected)
    throw new Error(`fan-out integrity: delivered ${got}, expected exactly ${expected}`)
  const serverMs = body.ms
  return {
    delPerSec: expected / (serverMs / 1000),
    serverMs,
    perPublishMs: serverMs / publishes,
    subs,
    publishes,
    delivered: got,
    expected,
  }
}

/** SSE throughput: drain N events as fast as the server pushes them, count `data:` lines + bytes. */
export async function sseThroughput(baseUrl: string, n = 200_000): Promise<SseResult> {
  const started = performance.now()
  const res = await fetch(`${baseUrl}/feed?n=${n}`, { headers: { accept: "text/event-stream" } })
  if (!res.body) throw new Error(`no SSE body (status ${res.status})`)
  const reader = res.body.getReader()
  let events = 0
  let bytes = 0
  const dec = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.length
    const chunk = dec.decode(value, { stream: true })
    for (let i = chunk.indexOf("data:"); i !== -1; i = chunk.indexOf("data:", i + 5)) events++
  }
  const secs = (performance.now() - started) / 1000
  return { evPerSec: n / secs, mib: bytes / 1024 / 1024, secs, events }
}

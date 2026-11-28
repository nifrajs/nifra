/**
 * Mixed good and hostile traffic against `server.mjs` for `SOAK_SECONDS`, failing if the server
 * stops answering or its resident memory keeps growing after the first third of the run.
 */
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import { connect as connectH2 } from "node:http2"
import { createConnection } from "node:net"
import { startServer } from "./ready.mjs"

const seconds = Number(process.env.SOAK_SECONDS ?? 300)
const allowedGrowthMb = Number(process.env.SOAK_GROWTH_MB ?? 48)
const SAMPLE_MS = 2000
// The growth check compares thirds of the run, each of which needs a memory sample.
if (!(seconds >= 10)) throw new Error("SOAK_SECONDS must be at least 10")
const OPERATION_MS = 30_000
const { server, port } = await startServer({ WS_DEFLATE: "1" })
const origin = `http://127.0.0.1:${port}`
const deadline = Date.now() + seconds * 1000
const counts = { http1: 0, http2: 0, websocket: 0, hostile: 0, failures: 0 }

const resident = () =>
  Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(server.pid)])
      .toString()
      .trim(),
  ) / 1024

/** A peer that stops answering must fail the run, not hang it. */
function within(operation) {
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(reject, OPERATION_MS, new Error(`no answer in ${OPERATION_MS} ms`))
  })
  return Promise.race([operation, expired]).finally(() => clearTimeout(timer))
}

async function loop(name, once_) {
  while (Date.now() < deadline) {
    try {
      await within(once_())
      counts[name] += 1
    } catch (error) {
      counts.failures += 1
      if (counts.failures < 5) console.error(name, error)
    }
  }
}

const http1 = async () => {
  const body = "x".repeat(Math.floor(Math.random() * 200_000))
  const response = await fetch(origin, {
    method: Math.random() < 0.5 ? "GET" : "POST",
    body: undefined,
  })
  if ((await response.json()) !== "ok") throw new Error("wrong body")
  const posted = await fetch(origin, { method: "POST", body })
  await posted.arrayBuffer()
}

const http2 = async () => {
  const session = connectH2(origin)
  session.on("error", () => {})
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const stream = session.request({ ":path": "/", ":method": index % 2 ? "POST" : "GET" })
        // Every fifth stream is cancelled part way.
        if (index % 5 === 4) stream.close(8)
        stream.on("error", () => {})
        stream.resume()
        stream.end()
        return once(stream, "close")
      }),
    )
  } finally {
    session.close()
  }
}

const websocket = async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  for (let i = 0; i < 10; i++) {
    const message = "m".repeat(Math.floor(Math.random() * 100_000))
    socket.send(message)
    await new Promise((resolve, reject) => {
      socket.onmessage = resolve
      socket.onerror = reject
      socket.onclose = () => reject(new Error("closed before the echo"))
    })
  }
  socket.close()
}

const HOSTILE = [
  "GET / HTTP/1.1\r\nHost: h\r\n",
  "POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 100000\r\n\r\nshort",
  "POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\nffffff\r\n",
  "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\u0000\u0000\u0000\u0004\u0000\u0000\u0000\u0000\u0000ÿÿ",
  "GET /ws HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n\u0081ÿ",
  "\u0016\u0003\u0001\u0000garbage\r\n\r\n",
]

/** A peer that sends something broken or half done, then drops the connection. */
const hostile = () =>
  new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("error", () => {})
    socket.on("close", resolve)
    socket.on("connect", () => {
      socket.write(Buffer.from(HOSTILE[Math.floor(Math.random() * HOSTILE.length)], "latin1"))
      setTimeout(() => socket.destroy(), Math.random() * 20)
    })
  })

const samples = []
const sampler = setInterval(() => {
  try {
    samples.push(resident())
  } catch {
    // The server is gone; the health check below reports it.
  }
}, SAMPLE_MS)
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
let passed = false
try {
  await Promise.all([
    ...Array.from({ length: 8 }, () => loop("http1", http1)),
    ...Array.from({ length: 2 }, () => loop("http2", http2)),
    ...Array.from({ length: 4 }, () => loop("websocket", websocket)),
    ...Array.from({ length: 8 }, () => loop("hostile", hostile)),
  ])
  const response = await fetch(origin, { signal: AbortSignal.timeout(OPERATION_MS) })
  const alive = await response.json()
  if (samples.length < 3) throw new Error(`only ${samples.length} memory samples`)
  const third = Math.floor(samples.length / 3)
  const middle = median(samples.slice(third, third * 2))
  const last = median(samples.slice(third * 2))
  console.log(JSON.stringify({ seconds, ...counts, middleRssMb: middle, lastRssMb: last }))
  passed = alive === "ok" && counts.failures === 0 && last - middle <= allowedGrowthMb
} finally {
  clearInterval(sampler)
  server.kill()
}
// Exit outright: an operation that timed out may still hold its socket open.
process.exit(passed ? 0 : 1)

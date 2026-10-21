#!/usr/bin/env bun
/**
 * The Workers live hub against a real local workerd: the platform behavior it relies on (attachment
 * and value sizes, alarms, heartbeat auto-responses), then a socket, a load, a watch and a publish
 * through the hub Durable Object, before and after the hub's memory goes.
 */
import { join, resolve } from "node:path"
import { rawUpgradeStatus } from "../packages/core/test/request-target-matrix.ts"
import { MAX_ATTACHMENT_BYTES, MAX_SOCKET_RECORD_BYTES } from "../packages/web/src/live-hub.ts"
import { startWranglerDev } from "./wrangler-dev.ts"

const ROOT = resolve(import.meta.dir, "..")
const CONFIG = join(ROOT, "packages/web/test/workerd-live/wrangler.toml")
/** Past this much quiet the runtime may evict a hub that holds only hibernatable sockets. */
const HIBERNATE_WAIT_MS = 15_000

type Frame = Record<string, unknown> | "p"

/** A socket whose frames queue until read. */
function open(
  url: string,
  origin: string,
): Promise<{ next(step: string): Promise<Frame>; send(data: string): void; close(): void }> {
  // Bun's client takes upgrade headers; the DOM constructor type does not know the option.
  const socket: WebSocket = Reflect.construct(WebSocket, [url, { headers: { origin } }])
  const inbox: Frame[] = []
  const waiting: ((frame: Frame) => void)[] = []
  socket.addEventListener("message", (event) => {
    const text = String(event.data)
    const frame: Frame = text === "p" ? "p" : JSON.parse(text)
    const waiter = waiting.shift()
    if (waiter === undefined) inbox.push(frame)
    else waiter(frame)
  })
  const next = (step: string): Promise<Frame> => {
    const frame = inbox.shift()
    if (frame !== undefined) return Promise.resolve(frame)
    return new Promise((resolveFrame, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${step}: no frame on ${url} within 5 s`)),
        5_000,
      )
      waiting.push((value) => {
        clearTimeout(timer)
        resolveFrame(value)
      })
    })
  }
  return new Promise((resolveOpen, reject) => {
    socket.addEventListener(
      "open",
      () => resolveOpen({ next, send: (data) => socket.send(data), close: () => socket.close() }),
      { once: true },
    )
    socket.addEventListener("error", () => reject(new Error(`could not open ${url}`)), {
      once: true,
    })
  })
}

async function json(res: Response): Promise<Record<string, unknown>> {
  const value: unknown = await res.json()
  if (typeof value !== "object" || value === null) throw new Error(`not a JSON object: ${value}`)
  return Object.fromEntries(Object.entries(value))
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function platform(origin: string): Promise<string[]> {
  const notes: string[] = []
  const limits = await json(await fetch(`${origin}/__probe/limits`))
  const attachmentBytes = Number(limits.attachmentBytes)
  if (attachmentBytes < MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `the runtime takes attachments of ${attachmentBytes} B, under the hub's ${MAX_ATTACHMENT_BYTES} B`,
    )
  }
  expectEqual("a socket record round-trips", limits.recordBytes, MAX_SOCKET_RECORD_BYTES)
  notes.push(`attachments up to ${attachmentBytes} B (hub uses <= ${MAX_ATTACHMENT_BYTES} B)`)

  const probe = await open(`${origin.replace("http", "ws")}/__probe/socket`, origin)
  probe.send("p")
  expectEqual("auto-response", await probe.next("auto-response"), "p")
  const beat = (await json(await fetch(`${origin}/__probe/beat`))).beat
  if (typeof beat !== "number") throw new Error("the runtime kept no auto-response timestamp")
  probe.close()
  notes.push("heartbeats answered by the runtime, timestamp kept")

  await fetch(`${origin}/__probe/alarm`)
  const set = Date.now()
  let fired: unknown = null
  while (fired === null && Date.now() - set < 10_000) {
    await Bun.sleep(100)
    fired = (await json(await fetch(`${origin}/__probe/alarm-fired`))).fired
  }
  if (typeof fired !== "number") throw new Error("the alarm never fired")
  notes.push(`alarm fired ${Date.now() - set} ms after a 500 ms schedule (polled)`)
  return notes
}

async function liveHub(origin: string, port: number): Promise<string[]> {
  const notes: string[] = []
  const foreign = await rawUpgradeStatus(
    port,
    "/_nifra/live",
    { Origin: "http://evil.test" },
    `127.0.0.1:${port}`,
  )
  expectEqual("a foreign Origin is refused", foreign, 403)

  const socket = await open(`${origin.replace("http", "ws")}/_nifra/live`, origin)
  const welcome = await socket.next("welcome")
  if (welcome === "p" || welcome.t !== "welcome")
    throw new Error(`no welcome: ${JSON.stringify(welcome)}`)
  const sid = String(welcome.sid)
  const load = async (id: string) => {
    const res = await fetch(`${origin}/_nifra/live/load`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-user": "alice" },
      body: JSON.stringify({
        path: `/posts/${id}`,
        sid,
        frame: "page",
        mode: "load",
        retain: [],
        grants: [],
      }),
    })
    const envelope = await json(res)
    const granted = envelope.live
    if (typeof granted !== "object" || granted === null)
      throw new Error(`no grant: ${JSON.stringify(envelope)}`)
    return Object.fromEntries(Object.entries(granted))
  }
  const granted = await load("1")
  const tags = Object.entries(Object(granted.tags))
  const tag = tags.find(
    ([, owners]) => Array.isArray(owners) && owners.includes("P:posts/[id]"),
  )?.[0]
  socket.send(JSON.stringify({ t: "watch", gen: 1, grants: [granted.grant] }))
  expectEqual("ready", await socket.next("ready"), { t: "ready", gen: 1, stale: [[]] })
  await fetch(`${origin}/__publish?key=post:1`, { method: "POST" })
  expectEqual("changed", await socket.next("changed"), { t: "changed", tag, spread: 0 })
  socket.send("p")
  expectEqual("heartbeat", await socket.next("heartbeat"), "p")
  notes.push("socket, load, watch, publish and heartbeat through the hub")

  const before = await (await fetch(`${origin}/__instance`)).text()
  await Bun.sleep(HIBERNATE_WAIT_MS)
  await fetch(`${origin}/__publish?key=post:1`, { method: "POST" })
  expectEqual("changed after the quiet", await socket.next("changed after the quiet"), {
    t: "changed",
    tag,
    spread: 0,
  })
  const after = await (await fetch(`${origin}/__instance`)).text()
  if (before === after)
    throw new Error(`the hub was not evicted after ${HIBERNATE_WAIT_MS} ms quiet`)
  notes.push(
    `hub evicted after ${HIBERNATE_WAIT_MS} ms quiet; the socket kept its watch from storage`,
  )
  socket.close()
  return notes
}

const dev = await startWranglerDev(CONFIG)
try {
  await dev.ready("/__nifra_ready__")
  const notes = [...(await platform(dev.origin)), ...(await liveHub(dev.origin, dev.port))]
  for (const note of notes) console.log(`✓ workerd live hub: ${note}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(dev.logs())
  process.exitCode = 1
} finally {
  await dev.stop()
}

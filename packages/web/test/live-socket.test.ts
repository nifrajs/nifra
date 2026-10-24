/**
 * The live socket over real Bun sockets, on both fan-out paths (native topics and the JS registry), and
 * the runtime's bus handling: ordering, revocation across processes, gaps and outages.
 */
import { afterEach, expect, jest, spyOn, test } from "bun:test"
import { TopicRegistry } from "@nifrajs/core/ws"
import { createWebApp, type Manifest, notFound, type RenderAdapter } from "../src/index.ts"
import {
  type Live,
  type LiveBus,
  type LiveBusEvent,
  type LiveBusInput,
  type LiveBusListener,
  type LiveOptions,
  live,
  nextSeq,
} from "../src/live.ts"
import { redisLiveBus } from "../src/live-redis.ts"
import type { LoaderContext } from "../src/manifest.ts"
import { memoryRedis } from "./memory-redis.ts"

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

const SECRET = "socket-test-secret-0123456789abcdef-1"
const OLD_SECRET = "socket-test-secret-0123456789abcdef-2"
const APP_ID = "socket-test"
const PAGE = "P:posts/[id]"
const ROOT = "L:_layout"

const stub: RenderAdapter = {
  renderToStream: () =>
    new ReadableStream({
      start(c) {
        c.close()
      },
    }),
  hydrationHead: () => "",
}

const stops: (() => void)[] = []
afterEach(() => {
  jest.useRealTimers()
  for (const stop of stops.splice(0)) stop()
})

interface Access {
  allowed: boolean
  pageRuns: number
}

interface Served {
  readonly app: ReturnType<typeof createWebApp>
  readonly runtime: Live
  readonly base: string
  readonly access: Access
}

interface ServeOptions {
  readonly live?: Partial<LiveOptions>
  readonly runtime?: Live
  /** Force the JS registry: a validated-send route makes the app forgo Bun's native topics. */
  readonly jsRegistry?: boolean
  readonly listen?: boolean
}

const userOf = (request: Request): string | null =>
  /(?:^|;\s*)user=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? null

const passThrough = {
  "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
} as const

function serve(options: ServeOptions = {}): Served {
  const access: Access = { allowed: true, pageRuns: 0 }
  const runtime =
    options.runtime ??
    live({ secret: SECRET, appId: APP_ID, subject: (ctx) => userOf(ctx.request), ...options.live })
  const manifest: Manifest = {
    routes: [
      {
        id: "posts/[id]",
        pattern: "/posts/:id",
        layoutIds: ["_layout"],
        layoutParams: [[]],
        file: "posts/[id].tsx",
        load: async () => ({
          default: "post",
          loader: (ctx: LoaderContext) => {
            access.pageRuns++
            if (!access.allowed) throw notFound()
            ctx.live(`post:${ctx.params.id}`)
            return { id: ctx.params.id }
          },
        }),
      },
    ],
    layouts: {
      _layout: {
        file: "root.tsx",
        load: async () => ({
          default: "root",
          loader: (ctx: LoaderContext) => {
            ctx.live("site:nav")
            return { root: true }
          },
        }),
      },
    },
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  const app = createWebApp({
    adapter: stub,
    manifest,
    clientEntry: "/c.js",
    live: runtime,
    use: (served) => {
      if (options.jsRegistry === true) {
        served.ws("/force-js-registry", { sendSchema: passThrough, validateSend: true })
      }
    },
  })
  if (options.listen === false) return { app, runtime, base: "http://127.0.0.1", access }
  const running = app.listen(0, { hostname: "127.0.0.1" })
  stops.push(() => running.stop(true))
  return { app, runtime, base: `http://127.0.0.1:${running.port}`, access }
}

type Frame = Record<string, unknown>

interface Client {
  readonly ws: WebSocket
  readonly sid: string
  next(): Promise<Frame | "p">
  /** Every frame sent before this resolves has arrived: the server answers heartbeats in order. */
  drain(): Promise<Frame[]>
  readonly closed: Promise<number>
}

async function connect(base: string, origin: string | null = base): Promise<Client> {
  const headers: Record<string, string> = origin === null ? {} : { origin }
  // Bun's client takes upgrade headers; the DOM constructor type does not know the option.
  const ws: WebSocket = Reflect.construct(WebSocket, [
    `${base.replace("http", "ws")}/_nifra/live`,
    { headers },
  ])
  stops.push(() => ws.close())
  const inbox: (Frame | "p")[] = []
  const waiting: ((frame: Frame | "p") => void)[] = []
  ws.onmessage = (event) => {
    const text = String(event.data)
    const frame = text === "p" ? "p" : JSON.parse(text)
    const waiter = waiting.shift()
    if (waiter === undefined) inbox.push(frame)
    else waiter(frame)
  }
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (event) => resolve(event.code)
  })
  const next = (): Promise<Frame | "p"> => {
    const frame = inbox.shift()
    if (frame !== undefined) return Promise.resolve(frame)
    return new Promise((resolve) => waiting.push(resolve))
  }
  const welcome = await Promise.race([next(), closed.then(() => undefined)])
  if (welcome === undefined || welcome === "p")
    return { ws, sid: "", next, drain: async () => [], closed }
  return {
    ws,
    sid: String(welcome.sid),
    next,
    closed,
    async drain() {
      ws.send("p")
      const seen: Frame[] = []
      for (let frame = await next(); frame !== "p"; frame = await next()) seen.push(frame)
      return seen
    },
  }
}

interface LoadResult {
  readonly status: number
  readonly grant: string | undefined
  readonly tags: Record<string, string[]>
}

async function liveLoad(
  served: Pick<Served, "app" | "base">,
  sid: string,
  extra: { retain?: string[]; grants?: string[]; user?: string } = {},
): Promise<LoadResult> {
  const res = await served.app.fetch(
    new Request(`${served.base}/_nifra/live/load`, {
      method: "POST",
      headers: {
        origin: served.base,
        "content-type": "application/json",
        cookie: `user=${extra.user ?? "alice"}`,
      },
      body: JSON.stringify({
        path: "/posts/42",
        sid,
        frame: "page",
        mode: "load",
        retain: extra.retain ?? [],
        grants: extra.grants ?? [],
      }),
    }),
  )
  const json: { live?: { grant?: string; tags?: Record<string, string[]> } } = await res
    .json()
    .catch(() => ({}))
  return { status: res.status, grant: json.live?.grant, tags: json.live?.tags ?? {} }
}

/** Load a frame for this client and install it; resolves with the load once `ready` arrives. */
async function watching(served: Served, client: Client, gen = 1): Promise<LoadResult> {
  const loaded = await liveLoad(served, client.sid)
  expect(loaded.grant).toBeDefined()
  client.ws.send(JSON.stringify({ t: "watch", gen, grants: [loaded.grant] }))
  expect(await client.next()).toEqual({ t: "ready", gen, stale: [[]] })
  return loaded
}

const tagOf = (loaded: LoadResult, owner: string): string | undefined =>
  Object.entries(loaded.tags).find(([, owners]) => owners.includes(owner))?.[0]

// --- One process, real sockets, both fan-out paths ------------------------------------------------

for (const jsRegistry of [false, true]) {
  const path = jsRegistry ? "JS registry" : "native topics"

  test(`${path}: a load, a watch and a change reach the socket as the grant's tag`, async () => {
    const registry = spyOn(TopicRegistry.prototype, "publish")
    try {
      const served = serve({ jsRegistry })
      const client = await connect(served.base)
      expect(client.sid).toMatch(/^[0-9a-f]{32}$/)
      const loaded = await watching(served, client)
      await served.runtime.publish("post:42")
      expect(await client.drain()).toEqual([{ t: "changed", tag: tagOf(loaded, PAGE), spread: 0 }])
      expect(registry.mock.calls.length > 0).toBe(jsRegistry)
    } finally {
      registry.mockRestore()
    }
  })

  test(`${path}: ready precedes every frame published after the install`, async () => {
    const served = serve({ jsRegistry })
    for (let round = 0; round < 10; round++) {
      const client = await connect(served.base)
      const loaded = await liveLoad(served, client.sid)
      client.ws.send(JSON.stringify({ t: "watch", gen: 1, grants: [loaded.grant] }))
      // Races the install: applied before it, it shows in `stale`; after it, as a frame after `ready`.
      const published = served.runtime.publish("post:42")
      const ready = await client.next()
      await published
      const after = await client.drain()
      expect(ready).toMatchObject({ t: "ready", gen: 1 })
      const stale: unknown = ready === "p" || !Array.isArray(ready.stale) ? [] : ready.stale[0]
      const heard = after.some(
        (frame) => frame.t === "changed" && frame.tag === tagOf(loaded, PAGE),
      )
      expect(heard || (Array.isArray(stale) && stale.includes(PAGE))).toBe(true)
      client.ws.close()
    }
  })

  test(`${path}: a socket never receives a tag it was not granted`, async () => {
    const served = serve({ jsRegistry })
    const alice = await connect(served.base)
    await watching(served, alice)
    const bob = await connect(served.base)
    const bobs = await liveLoad(served, bob.sid, { user: "bob" })
    bob.ws.send(JSON.stringify({ t: "watch", gen: 1, grants: [bobs.grant] }))
    await bob.next()
    await served.runtime.publish("post:7", "comments:42")
    expect(await alice.drain()).toEqual([])
    expect(await bob.drain()).toEqual([])
  })
}

test("the handshake refuses an untrusted Origin", async () => {
  const served = serve()
  const evil = await connect(served.base, "https://evil.test")
  expect(evil.sid).toBe("")
  expect(await evil.closed).not.toBe(1000)
})

test("revoke and revokeAll close live sockets with 4403", async () => {
  const served = serve()
  const alice = await connect(served.base)
  await watching(served, alice)
  const bob = await connect(served.base)
  const bobs = await liveLoad(served, bob.sid, { user: "bob" })
  bob.ws.send(JSON.stringify({ t: "watch", gen: 1, grants: [bobs.grant] }))
  await bob.next()
  await served.runtime.revoke("alice")
  expect(await alice.closed).toBe(4403)
  await served.runtime.revokeAll()
  expect(await bob.closed).toBe(4403)
})

// --- Several processes on one bus -------------------------------------------------------------------

/** A shared authority with one inbox per process; `manual` inboxes deliver only when pumped. */
class SharedBus {
  private last = nextSeq(0, Date.now())
  private readonly members: {
    readonly listener: LiveBusListener
    readonly inbox: LiveBusEvent[]
    manual: boolean
  }[] = []

  process(manual = false): LiveBus & {
    pump(count?: number): void
    gap(): void
    down(): void
    deliver(event: LiveBusEvent): void
  } {
    let member: (typeof this.members)[number] | undefined
    return {
      append: async (input: LiveBusInput) => {
        this.last = nextSeq(this.last, Date.now())
        const event: LiveBusEvent = { ...input, seq: this.last }
        for (const each of this.members) {
          if (each.manual) each.inbox.push(event)
          else each.listener.event(event)
        }
        return this.last
      },
      subscribe: async (listener: LiveBusListener) => {
        member = { listener, inbox: [], manual }
        this.members.push(member)
        return { head: this.last, close: () => {} }
      },
      pump: (count = Number.POSITIVE_INFINITY) => {
        for (let i = 0; i < count && member !== undefined; i++) {
          const event = member.inbox.shift()
          if (event === undefined) break
          member.listener.event(event)
        }
      },
      gap: () => {
        if (member === undefined) return
        member.inbox.length = 0
        member.listener.gap(this.last)
      },
      down: () => member?.listener.down(),
      deliver: (event) => member?.listener.event(event),
    }
  }

  get head(): number {
    return this.last
  }
}

const runtimeOn = (bus: LiveBus, options: Partial<LiveOptions> = {}): Live =>
  live({
    secret: SECRET,
    appId: APP_ID,
    subject: (ctx) => userOf(ctx.request),
    bus,
    ...options,
  })

test("two processes: a revokeKey interleaved with publishes leaves one terminal frame and nothing after", async () => {
  const bus = new SharedBus()
  const a = runtimeOn(bus.process())
  const busB = bus.process(true)
  const b = serve({ runtime: runtimeOn(busB) })
  await Promise.all([a.ready, b.runtime.ready])
  const client = await connect(b.base)
  const loaded = await watching(b, client)
  const page = tagOf(loaded, PAGE)
  const nav = tagOf(loaded, ROOT)

  jest.useFakeTimers()
  await a.publish("post:42")
  await a.revokeKey("post:42")
  await a.publish("post:42")
  await a.publish("post:42")
  // A later change the socket still watches: once it arrives, process B applied everything before it.
  await a.publish("site:nav")
  busB.pump()
  const heard: Frame[] = []
  for (let frame = await client.next(); frame !== "p"; frame = await client.next()) {
    heard.push(frame)
    if (frame.tag === nav) break
  }
  jest.advanceTimersByTime(100)
  heard.push(...(await client.drain()))
  expect(heard).toEqual([
    { t: "changed", tag: page, spread: 0 },
    { t: "changed", tag: page, spread: 0 },
    { t: "changed", tag: nav, spread: 0 },
  ])
  await a.publish("post:42")
  busB.pump()
  await a.publish("site:nav")
  busB.pump()
  expect(await client.next()).toEqual({ t: "changed", tag: nav, spread: 0 })
  jest.advanceTimersByTime(100)
  expect(await client.drain()).toEqual([])

  // After a reconnect the old grant keeps nothing, and its loader decides again.
  b.access.allowed = false
  const again = await connect(b.base)
  const runs = b.access.pageRuns
  const reloaded = await liveLoad(b, client.sid, { retain: [PAGE], grants: [loaded.grant ?? ""] })
  expect(reloaded.status).toBe(404)
  expect(b.access.pageRuns).toBe(runs + 1)
  again.ws.send(JSON.stringify({ t: "watch", gen: 1, grants: [loaded.grant] }))
  expect(await again.closed).toBe(4401)

  // After a gap, every grant issued before it is refused, and the socket is told to resync.
  b.access.allowed = true
  const third = await connect(b.base)
  const thirds = await watching(b, third)
  // Process B misses this one: the gap reports that events up to the bus head are unknown.
  await a.publish("other:1")
  busB.gap()
  expect(await third.closed).toBe(1013)
  const runsBefore = b.access.pageRuns
  const fresh = await liveLoad(b, third.sid, { retain: [PAGE], grants: [thirds.grant ?? ""] })
  expect(fresh.grant).toBeDefined()
  expect(b.access.pageRuns).toBe(runsBefore + 1)
})

test("rotation across processes: a grant under the demoted secret hears changes from either process", async () => {
  const bus = new SharedBus()
  const oldProcess = serve({
    runtime: runtimeOn(bus.process(), { secret: OLD_SECRET }),
    listen: false,
  })
  const newProcess = serve({ runtime: runtimeOn(bus.process(), { secret: [SECRET, OLD_SECRET] }) })
  await Promise.all([oldProcess.runtime.ready, newProcess.runtime.ready])
  const client = await connect(newProcess.base)
  const loaded = await liveLoad({ app: oldProcess.app, base: newProcess.base }, client.sid)
  client.ws.send(JSON.stringify({ t: "watch", gen: 1, grants: [loaded.grant] }))
  expect(await client.next()).toEqual({ t: "ready", gen: 1, stale: [[]] })
  jest.useFakeTimers()
  await oldProcess.runtime.publish("post:42")
  // The publish settles once the OLD process applies it; the socket's process reads it on its own.
  expect(await client.next()).toEqual({ t: "changed", tag: tagOf(loaded, PAGE), spread: 0 })
  expect(await client.drain()).toEqual([])
  jest.advanceTimersByTime(100)
  await newProcess.runtime.publish("post:42")
  expect(await client.drain()).toEqual([{ t: "changed", tag: tagOf(loaded, PAGE), spread: 0 }])
})

test("a repeated bus event is applied once", async () => {
  const bus = new SharedBus()
  const process = bus.process(true)
  const served = serve({ runtime: runtimeOn(process) })
  await served.runtime.ready
  const client = await connect(served.base)
  const loaded = await watching(served, client)
  jest.useFakeTimers()
  const event: LiveBusEvent = {
    type: "change",
    keys: ["post:42"],
    seq: nextSeq(bus.head, Date.now()),
  }
  process.deliver(event)
  expect(await client.next()).toEqual({ t: "changed", tag: tagOf(loaded, PAGE), spread: 0 })
  jest.advanceTimersByTime(100)
  process.deliver(event)
  jest.advanceTimersByTime(100)
  expect(await client.drain()).toEqual([])
})

test("an unreachable bus closes sockets, refuses new ones, and loads issue and honor no grant", async () => {
  const bus = new SharedBus()
  const process = bus.process(true)
  const served = serve({ runtime: runtimeOn(process) })
  await served.runtime.ready
  const client = await connect(served.base)
  const loaded = await watching(served, client)
  process.down()
  expect(await client.closed).toBe(1013)
  const refused = await connect(served.base)
  expect(await refused.closed).toBe(1013)
  const runs = served.access.pageRuns
  const during = await liveLoad(served, client.sid, {
    retain: [PAGE, ROOT],
    grants: [loaded.grant ?? ""],
  })
  expect(during.status).toBe(200)
  expect(during.grant).toBeUndefined()
  expect(served.access.pageRuns).toBe(runs + 1)
  process.gap()
  const back = await connect(served.base)
  expect(back.sid).toMatch(/^[0-9a-f]{32}$/)
  await watching(served, back)
})

test("a bus event the process cannot apply closes every socket to resync", async () => {
  const bus = new SharedBus()
  const process = bus.process(true)
  const errors: string[] = []
  const logger = { ...quiet, error: (message: string) => errors.push(message) }
  const served = serve({ runtime: runtimeOn(process, { logger }) })
  await served.runtime.ready
  const client = await connect(served.base)
  await watching(served, client)
  const broken = JSON.parse(`{"type":"change","keys":null,"seq":${nextSeq(bus.head, Date.now())}}`)
  process.deliver(broken)
  expect(await client.closed).toBe(1013)
  expect(errors).toEqual(["live bus event could not be applied: live sockets resync"])
})

test("status() counts sockets, applied events and the frames sent; close() ends them with 1001", async () => {
  const served = serve()
  await served.runtime.ready
  expect(served.runtime.status()).toEqual({
    ready: true,
    down: false,
    downSince: undefined,
    sockets: 0,
    loads: 0,
    events: 0,
    notified: 0,
    lagMs: undefined,
  })
  const client = await connect(served.base)
  await watching(served, client)
  await served.runtime.publish("post:42")
  expect(await client.next()).toMatchObject({ t: "changed" })
  expect(served.runtime.status()).toMatchObject({
    down: false,
    sockets: 1,
    events: 1,
    notified: 1,
    lagMs: expect.any(Number),
  })
  await served.runtime.close()
  expect(await client.closed).toBe(1001)
  const after = served.runtime.status()
  expect(after).toMatchObject({ down: true, sockets: 0, downSince: expect.any(Number) })
  await expect(served.runtime.publish("post:42")).rejects.toThrow(/closed/)
  // Idempotent, and a socket opened after it is refused.
  await served.runtime.close()
  const late = await connect(served.base)
  expect(await late.closed).toBe(1013)
})

test("the bus going down and coming back is logged once each way, and status() follows it", async () => {
  const bus = new SharedBus()
  const process = bus.process(true)
  const lines: string[] = []
  const at = (level: string) => (message: string) => lines.push(`${level} ${message}`)
  const logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }
  const served = serve({ runtime: runtimeOn(process, { logger }) })
  await served.runtime.ready
  const client = await connect(served.base)
  await watching(served, client)
  process.down()
  process.down()
  expect(await client.closed).toBe(1013)
  expect(served.runtime.status()).toMatchObject({ down: true, downSince: expect.any(Number) })
  process.gap()
  await Promise.resolve()
  expect(served.runtime.status()).toMatchObject({ down: false, downSince: undefined })
  process.gap()
  expect(lines).toEqual([
    "error live bus unreachable: live sockets closed, open pages poll until it answers",
    "info live bus answering again: live sockets resume",
    "warn live bus lost events before this process read them: live sockets resync",
  ])
})

test("a malformed revocation from the bus fails closed", async () => {
  const bus = new SharedBus()
  const process = bus.process(true)
  const served = serve({ runtime: runtimeOn(process) })
  await served.runtime.ready
  const client = await connect(served.base)
  const loaded = await watching(served, client)
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    // Each its own seq: a repeated one is skipped as a duplicate delivery.
    let seq = nextSeq(bus.head, Date.now())
    for (const broken of [
      { type: "revoke", sub: 7, key: null },
      { type: "revoke", sub: null, key: "bad key" },
      { type: "mystery" },
    ]) {
      const again = await connect(served.base)
      await watching(served, again)
      seq += 1000
      process.deliver(JSON.parse(JSON.stringify({ ...broken, seq })))
      expect(await again.closed).toBe(1013)
    }
    expect(await client.closed).toBe(1013)
    // Grants issued before the resync keep nothing.
    const runs = served.access.pageRuns
    await liveLoad(served, client.sid, { retain: [PAGE], grants: [loaded.grant ?? ""] })
    expect(served.access.pageRuns).toBe(runs + 1)
  } finally {
    error.mockRestore()
  }
})

test("a gap behind what the process already applied keeps its watermarks current", async () => {
  const bus = new SharedBus()
  const process = bus.process(true)
  const served = serve({ runtime: runtimeOn(process) })
  await served.runtime.ready
  const first = await connect(served.base)
  await watching(served, first)
  // The bus reports a head older than what this process has seen.
  process.deliver({
    type: "change",
    keys: ["other:1"],
    seq: nextSeq(bus.head, Date.now()) + 1_000_000,
  })
  await first.drain()
  process.gap()
  expect(await first.closed).toBe(1013)
  // A fresh load's watermark is known history: ready reports nothing stale.
  const second = await connect(served.base)
  await watching(served, second)
})

test("a Redis stream trimmed past a process's reader: sockets resync and older grants keep nothing", async () => {
  const redis = memoryRedis()
  const served = serve({
    runtime: live({
      secret: SECRET,
      appId: APP_ID,
      subject: (ctx) => userOf(ctx.request),
      bus: redisLiveBus({ ...redis, maxLength: 2 }),
    }),
  })
  await served.runtime.ready
  const client = await connect(served.base)
  const loaded = await watching(served, client)
  // This process's parked read fails on the first append; the other process appends three more,
  // and the stream keeps two, before the read is retried.
  redis.failures.read = 1
  const other = redisLiveBus({ ...redis, maxLength: 2 })
  for (const key of ["other:1", "post:42", "other:2", "other:3"]) {
    await other.append({ type: "change", keys: [key] })
  }
  expect(await client.closed).toBe(1013)
  const runs = served.access.pageRuns
  const again = await liveLoad(served, client.sid, { retain: [PAGE], grants: [loaded.grant ?? ""] })
  expect(again.grant).toBeDefined()
  expect(served.access.pageRuns).toBe(runs + 1)
  // The history is known again from the gap on: a fresh load installs with nothing stale.
  const back = await connect(served.base)
  await watching(served, back)
})

test("publish, revoke and revokeKey check their arguments", async () => {
  const runtime = live({ secret: SECRET, subject: () => null })
  await runtime.publish()
  expect(runtime.publish("bad key")).rejects.toThrow(TypeError)
  expect(runtime.revokeKey("bad key")).rejects.toThrow(TypeError)
  expect(Reflect.apply(runtime.revokeKey, runtime, ["post:1", 7])).rejects.toThrow(TypeError)
  expect(Reflect.apply(runtime.revoke, runtime, [7])).rejects.toThrow(TypeError)
  await runtime.publish("post:1", "post:1")
  await runtime.revokeKey("post:1", "alice")
})

test("socket options are checked at construction", () => {
  const subject = () => null
  for (const bad of [
    { maxSockets: 0 },
    { instances: 0 },
    { reloadRate: 1.5 },
    { spreadFloor: -1 },
    { spreadFloor: 5001 },
    { maxRssBytes: 0 },
    { path: "live" },
    { path: "/_nifra/live?x" },
    { path: "/_nifra/live/load" },
  ]) {
    expect(() => live({ secret: SECRET, subject, ...bad })).toThrow(TypeError)
  }
})

test("a runtime holds the apps it is attached to weakly: a discarded app can be collected", async () => {
  const runtime = live({ secret: SECRET, appId: APP_ID, subject: () => "alice" })
  await runtime.ready
  // A dev server's rebuilds: each new app is attached to the same runtime, and the old one dropped.
  const discarded = ((): WeakRef<object> => new WeakRef(serve({ runtime, listen: false }).app))()
  const kept = serve({ runtime })
  // Bun scans the stack conservatively: a few rounds, each from a fresh turn, let a stale slot go.
  for (let i = 0; i < 50 && discarded.deref() !== undefined; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    Bun.gc(true)
  }
  expect(discarded.deref()).toBeUndefined()
  // The kept app still hears changes.
  const client = await connect(kept.base)
  const loaded = await watching(kept, client)
  await runtime.publish("post:42")
  expect(await client.drain()).toEqual([{ t: "changed", tag: tagOf(loaded, PAGE), spread: 0 }])
})

/**
 * The Workers live hub, on a fake Durable Object host: an app isolate reaches it only through the
 * binding, exactly as on Workers. Hibernation is a new hub object over the same state.
 */
import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { FIRST_WATCH_MS } from "../src/live/hub.ts"
import {
  HUB_APPEND_PATH,
  HUB_CONFIG_HEADER,
  HUB_ORIGIN,
  hubConfigOf,
  type LiveHubNamespace,
  MAX_APPEND_KEYS,
  parseAuthorityReply,
} from "../src/live/hub-protocol.ts"
import { createKeyring } from "../src/live/keyring.ts"
import { REVOCATION_SKEW_MS, Revocations, RevocationView } from "../src/live/revocations.ts"
import { live } from "../src/live.ts"
import {
  ALARM_GAP_MS,
  liveHub,
  MAX_ATTACHMENT_BYTES,
  MAX_SOCKET_RECORD_BYTES,
} from "../src/live-hub.ts"
import {
  FakeAutoResponse,
  type FakeSocket,
  FakeState,
  installWorkerGlobals,
} from "./fake-durable-object.ts"

const SECRET = "h".repeat(32)
const APP_ID = "hub-test"
const ORIGIN = "http://app.test"
const PAGE = "P:posts/[id]"

let undo = (): void => {}
beforeEach(() => {
  undo = installWorkerGlobals()
})
afterEach(() => {
  undo()
  setSystemTime()
})

const empty = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.close()
    },
  })

const adapter: RenderAdapter = { renderToStream: empty, hydrationHead: () => "" }

const manifest: Manifest = {
  routes: [
    {
      id: "posts/[id]",
      pattern: "/posts/:id",
      layoutIds: [],
      layoutParams: [],
      file: "posts/[id].tsx",
      load: async () => ({
        default: "post",
        loader: (ctx: { params: Record<string, string>; live(...keys: string[]): void }) => {
          ctx.live(`post:${ctx.params.id}`)
          return { id: ctx.params.id }
        },
      }),
    },
  ],
  layouts: {},
  notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
}

const userOf = (request: Request): string | null =>
  /(?:^|;\s*)user=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? null

interface DeploymentOptions {
  readonly ttl?: number
  readonly hubTtl?: number
  readonly maxMemberships?: number
}

/** One app isolate and its hub. */
function deployment(options: DeploymentOptions = {}) {
  const state = new FakeState()
  const ttl = options.ttl ?? 600
  const Hub = liveHub(() => ({
    secret: SECRET,
    appId: APP_ID,
    grantTtl: options.hubTtl ?? ttl,
    maxMemberships: options.maxMemberships,
  }))
  const box = { hub: new Hub(state, {}), reachable: true }
  const names: string[] = []
  const namespace: LiveHubNamespace = {
    idFromName: (name) => {
      names.push(name)
      return name
    },
    get: () => ({
      fetch: async (req) => {
        if (!box.reachable) throw new Error("[fake] the hub is unreachable")
        return box.hub.fetch(req)
      },
    }),
  }
  const runtime = live({
    secret: SECRET,
    appId: APP_ID,
    grantTtl: ttl,
    subject: (ctx) => userOf(ctx.request),
    hub: namespace,
  })
  const app = createWebApp({ adapter, manifest, clientEntry: "/c.js", live: runtime })
  return {
    state,
    runtime,
    app,
    names,
    box,
    /** The hub's memory goes; its sockets and storage stay. */
    hibernate(): void {
      box.hub = new Hub(state, {})
    },
  }
}

type Deployment = ReturnType<typeof deployment>

async function handshake(d: Deployment, origin = ORIGIN): Promise<Response> {
  return await d.app.fetch(
    new Request(`${ORIGIN}/_nifra/live`, {
      headers: { upgrade: "websocket", connection: "Upgrade", origin },
    }),
  )
}

async function connect(d: Deployment): Promise<{ socket: FakeSocket; sid: string }> {
  const res = await handshake(d)
  expect(res.status).toBe(101)
  const socket = d.state.last
  const [welcome] = socket.take()
  if (typeof welcome !== "object" || welcome === null || !("sid" in welcome)) {
    throw new Error("[test] no welcome")
  }
  return { socket, sid: String(welcome.sid) }
}

interface Granted {
  readonly grant?: string
  readonly tags?: Record<string, string[]>
  readonly page?: string
}

interface Presented {
  readonly grant?: string | undefined
  readonly retain?: readonly string[]
}

async function load(
  d: Deployment,
  sid: string,
  id = "1",
  user = "alice",
  presented: Presented = {},
): Promise<Granted> {
  const res = await d.app.fetch(
    new Request(`${ORIGIN}/_nifra/live/load`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: `user=${user}` },
      body: JSON.stringify({
        path: `/posts/${id}`,
        sid,
        frame: "page",
        mode: "load",
        retain: presented.retain ?? [],
        grants: presented.grant === undefined ? [] : [presented.grant],
      }),
    }),
  )
  expect(res.status).toBe(200)
  const envelope: { live?: Granted } = await res.json()
  return envelope.live ?? {}
}

function tagOf(granted: Granted, owner: string): string | undefined {
  return Object.entries(granted.tags ?? {}).find(([, owners]) => owners.includes(owner))?.[0]
}

function watch(d: Deployment, socket: FakeSocket, gen: number, grants: (string | undefined)[]) {
  return d.box.hub.webSocketMessage(socket, JSON.stringify({ t: "watch", gen, grants }))
}

test("a handshake, a load, a watch and a publish all go through the one hub", async () => {
  const d = deployment()
  const { socket, sid } = await connect(d)
  expect(d.names.every((name) => name === `nifra-live:${APP_ID}`)).toBe(true)
  expect(d.state.autoResponse).toEqual(new FakeAutoResponse("p", "p"))
  const granted = await load(d, sid)
  expect(granted.grant).toBeString()
  await watch(d, socket, 1, [granted.grant])
  expect(socket.take()).toEqual([{ t: "ready", gen: 1, stale: [[]] }])
  await d.runtime.publish("post:1")
  expect(socket.take()).toEqual([{ t: "changed", tag: tagOf(granted, PAGE), spread: 0 }])
  // Another key reaches nobody here.
  await d.runtime.publish("post:2")
  expect(socket.take()).toEqual([])
  expect(socket.largestAttachment).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES)
})

test("a publish of more keys than one call carries goes out in parts, and every key arrives", async () => {
  const d = deployment()
  const { socket, sid } = await connect(d)
  const granted = await load(d, sid)
  await watch(d, socket, 1, [granted.grant])
  socket.take()
  const appends = spyOn(d.box.hub, "fetch")
  const others = Array.from({ length: 2 * MAX_APPEND_KEYS }, (_, n) => `other:${n}`)
  // The watched key is in the last part.
  await d.runtime.publish(...others, "post:1")
  expect(appends).toHaveBeenCalledTimes(3)
  expect(socket.take()).toEqual([{ t: "changed", tag: tagOf(granted, PAGE), spread: 0 }])
})

test("a revoked subject named __proto__ stays revoked through the hub's authority reply", () => {
  const stored = new Revocations(1, 600_000)
  stored.apply({ type: "revoke", sub: "__proto__", key: null, seq: 50 }, Date.now())
  const wire = JSON.stringify({ seq: 60, ...stored.snapshot(["__proto__"], []) })
  const reply = parseAuthorityReply(JSON.parse(wire))
  if (reply === undefined) throw new Error("[test] the reply was refused")
  const claims = {
    v: 1 as const,
    sid: "a".repeat(32),
    sub: "__proto__",
    path: "/posts/1",
    frame: "page",
    owners: {},
    s: 10,
    r: 0,
    iat: 0,
    exp: 0,
    aud: APP_ID,
  }
  expect(stored.grantRevoked(claims)).toBe(true)
  expect(new RevocationView(reply).grantRevoked(claims)).toBe(true)
})

test("a socket from a foreign Origin is refused before the hub accepts it", async () => {
  const d = deployment()
  const res = await handshake(d, "http://evil.test")
  expect(res.status).toBe(403)
  expect(d.state.accepted).toEqual([])
})

test("after hibernation a socket keeps its watch, and an older watermark reads as stale", async () => {
  const d = deployment()
  const first = await connect(d)
  const granted = await load(d, first.sid)
  await watch(d, first.socket, 1, [granted.grant])
  first.socket.take()
  const second = await connect(d)
  const before = await load(d, second.sid, "2")
  // An event after that load, before the hub's memory goes.
  await d.runtime.publish("post:9")
  d.hibernate()
  await d.runtime.publish("post:1")
  expect(first.socket.take()).toEqual([{ t: "changed", tag: tagOf(granted, PAGE), spread: 0 }])
  // History before the wake is unknown: a watermark older than the hub's last seq reloads its owner.
  await watch(d, second.socket, 1, [before.grant])
  expect(second.socket.take()).toEqual([{ t: "ready", gen: 1, stale: [[PAGE]] }])
  // The watch gen survived too: a replay of gen 1 is ignored.
  await watch(d, first.socket, 1, [granted.grant])
  expect(first.socket.take()).toEqual([])
})

test("revocations outlive the hub's memory", async () => {
  const d = deployment()
  const { socket, sid } = await connect(d)
  const alice = await load(d, sid)
  const bob = await connect(d)
  const bobs = await load(d, bob.sid, "1", "bob")
  await d.runtime.revoke("alice")
  await d.runtime.revokeKey("post:1", "bob")
  d.hibernate()
  await watch(d, socket, 1, [alice.grant])
  expect(socket.closed).toEqual({ code: 4403, reason: "revoked" })
  await watch(d, bob.socket, 1, [bobs.grant])
  expect(bob.socket.closed).toEqual({ code: 4401, reason: "grant" })
  // A grant issued after the revocation is honored.
  const fresh = await connect(d)
  const again = await load(d, fresh.sid)
  await watch(d, fresh.socket, 1, [again.grant])
  expect(fresh.socket.take()).toEqual([{ t: "ready", gen: 1, stale: [[]] }])
})

test("an event stored but never applied sends every restored socket to resync", async () => {
  const d = deployment()
  const { socket, sid } = await connect(d)
  await watch(d, socket, 1, [(await load(d, sid)).grant])
  const seq = d.state.storage.data.get("seq")
  expect(d.state.storage.data.get("applied")).toBe(seq)
  // The seq was stored, then the hub went before it applied the event.
  d.state.storage.data.set("seq", Number(seq) + 1)
  d.hibernate()
  await d.runtime.ready
  await load(d, sid)
  expect(socket.closed).toEqual({ code: 1013, reason: "resync" })
  expect(d.state.storage.data.get("applied")).toBe(Number(seq) + 1)
})

test("an app configured unlike its hub gets no grant and no publish", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const d = deployment({ ttl: 600, hubTtl: 900 })
    const { sid } = await connect(d)
    expect((await load(d, sid)).grant).toBeUndefined()
    await expect(d.runtime.publish("post:1")).rejects.toThrow("the hub did not take the event")
    const logged = errors.mock.calls.map((call) => String(call[0]))
    expect(
      logged.filter((line) => line.includes("different `secret`, `appId` or `grantTtl`")),
    ).toHaveLength(1)
  } finally {
    errors.mockRestore()
  }
})

test("an unreachable hub refuses every socket, grant and publish", async () => {
  const d = deployment()
  const { sid } = await connect(d)
  d.box.reachable = false
  expect((await handshake(d)).status).toBe(503)
  expect((await load(d, sid)).grant).toBeUndefined()
  await expect(d.runtime.publish("post:1")).rejects.toThrow("the hub did not take the event")
})

test("a grant's expiry is checked before every frame, whenever the alarm runs", async () => {
  const start = Date.now()
  const d = deployment({ ttl: 60 })
  const { socket, sid } = await connect(d)
  await watch(d, socket, 1, [(await load(d, sid)).grant])
  socket.take()
  setSystemTime(new Date(start + 61_000))
  await d.runtime.publish("post:1")
  expect(socket.take()).toEqual([])
  expect(socket.closed).toEqual({ code: 4401, reason: "expired" })
})

test("one alarm at the earliest deadline, never closer than the gap; it sweeps and prunes", async () => {
  const start = Date.now()
  setSystemTime(new Date(start))
  const d = deployment({ ttl: 60 })
  const { socket, sid } = await connect(d)
  // Yet to watch: the end of its first minute.
  expect(d.state.storage.alarm).toBe(start + FIRST_WATCH_MS)
  await watch(d, socket, 1, [(await load(d, sid)).grant])
  // The grant expires in 60 s: the alarm moves up to it.
  const alarm = d.state.storage.alarm ?? 0
  expect(alarm).toBeGreaterThanOrEqual(start + ALARM_GAP_MS)
  expect(alarm).toBeLessThanOrEqual(start + 60_000)
  await d.runtime.revokeKey("other:key")
  expect([...d.state.storage.data.keys()].filter((name) => name.startsWith("r:"))).toHaveLength(1)
  // Past the grant's expiry: the alarm closes the socket.
  setSystemTime(new Date(start + 61_000))
  d.state.storage.alarm = null
  await d.box.hub.alarm()
  expect(socket.closed).toEqual({ code: 4401, reason: "expired" })
  // The revocation's retention is the next deadline.
  const retention = start + 60_000 + REVOCATION_SKEW_MS
  expect(d.state.storage.alarm ?? 0).toBeGreaterThanOrEqual(retention)
  setSystemTime(new Date((d.state.storage.alarm ?? 0) + 1))
  d.state.storage.alarm = null
  await d.box.hub.alarm()
  expect([...d.state.storage.data.keys()].filter((name) => name.startsWith("r:"))).toEqual([])
  expect(d.state.storage.alarm).toBeNull()
})

test("a quiet socket stays while the runtime answers its heartbeats", async () => {
  const start = Date.now()
  setSystemTime(new Date(start))
  const d = deployment()
  const beating = await connect(d)
  await watch(d, beating.socket, 1, [(await load(d, beating.sid)).grant])
  const silent = await connect(d)
  d.state.beats.set(beating.socket, new Date(start + 140_000))
  setSystemTime(new Date(start + 160_000))
  await d.box.hub.alarm()
  expect(beating.socket.closed).toBeUndefined()
  expect(silent.socket.closed).toEqual({ code: 1008, reason: "idle" })
})

test("a socket that holds no tag closes after a minute, heartbeats or not, across hibernation", async () => {
  const start = Date.now()
  setSystemTime(new Date(start))
  const d = deployment()
  const idle = await connect(d)
  const listening = await connect(d)
  await watch(d, listening.socket, 1, [(await load(d, listening.sid)).grant])
  d.hibernate()
  d.state.beats.set(idle.socket, new Date(start + FIRST_WATCH_MS - 1000))
  d.state.beats.set(listening.socket, new Date(start + FIRST_WATCH_MS - 1000))
  setSystemTime(new Date(start + FIRST_WATCH_MS))
  await d.box.hub.alarm()
  expect(idle.socket.closed).toEqual({ code: 1000, reason: "unwatched" })
  expect(listening.socket.closed).toBeUndefined()
})

test("a socket that leaves takes its record with it; a record with no socket goes on wake", async () => {
  const d = deployment()
  const { socket, sid } = await connect(d)
  await watch(d, socket, 1, [(await load(d, sid)).grant])
  expect(d.state.storage.data.has(`s:${sid}`)).toBe(true)
  socket.readyState = 3
  await d.box.hub.webSocketClose(socket)
  expect(d.state.storage.data.has(`s:${sid}`)).toBe(false)
  d.state.storage.data.set(`s:${"e".repeat(32)}`, { sub: null, exp: 1, tags: [] })
  d.hibernate()
  await d.runtime.ready
  await load(d, sid)
  expect([...d.state.storage.data.keys()].filter((name) => name.startsWith("s:"))).toEqual([])
})

test("concurrent publishes apply one at a time, in seq order", async () => {
  const d = deployment()
  const { socket, sid } = await connect(d)
  const granted = await load(d, sid)
  await watch(d, socket, 1, [granted.grant])
  socket.take()
  await Promise.all(Array.from({ length: 20 }, (_, i) => d.runtime.publish(`post:${i}`)))
  expect(d.state.storage.data.get("applied")).toBe(d.state.storage.data.get("seq"))
  expect(socket.take()).toEqual([{ t: "changed", tag: tagOf(granted, PAGE), spread: 0 }])
  // History stayed in order: a grant from now is current.
  const next = await connect(d)
  await watch(d, next.socket, 1, [(await load(d, next.sid)).grant])
  expect(next.socket.take()).toEqual([{ t: "ready", gen: 1, stale: [[]] }])
})

test("the hub answers only its own calls, from a matching app", async () => {
  const d = deployment()
  await d.runtime.ready
  const ring = await createKeyring({ secrets: [SECRET], appId: APP_ID, ttl: 600 })
  const call = (path: string, body: string, origin = HUB_ORIGIN, method = "POST") =>
    d.box.hub.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: { "content-type": "application/json", [HUB_CONFIG_HEADER]: hubConfigOf(ring) },
        body: method === "POST" ? body : null,
      }),
    )
  expect((await call(HUB_APPEND_PATH, "{}", ORIGIN)).status).toBe(404)
  expect((await call("/__nifra_live_hub/other", "{}")).status).toBe(404)
  expect((await call(HUB_APPEND_PATH, "", HUB_ORIGIN, "GET")).status).toBe(404)
  expect((await call(HUB_APPEND_PATH, "not json")).status).toBe(400)
  expect(
    (await call(HUB_APPEND_PATH, JSON.stringify({ type: "change", keys: ["bad key"] }))).status,
  ).toBe(400)
  const ok = await call(HUB_APPEND_PATH, JSON.stringify({ type: "change", keys: ["post:1"] }))
  expect(ok.status).toBe(200)
  const errors = spyOn(console, "error").mockImplementation(() => {})
  const other = await createKeyring({ secrets: ["x".repeat(32)], appId: APP_ID, ttl: 600 })
  const foreign = await d.box.hub.fetch(
    new Request(`${HUB_ORIGIN}${HUB_APPEND_PATH}`, {
      method: "POST",
      headers: { [HUB_CONFIG_HEADER]: hubConfigOf(other) },
      body: JSON.stringify({ type: "change", keys: ["post:1"] }),
    }),
  )
  errors.mockRestore()
  expect(foreign.status).toBe(409)
})

test("a binary frame closes the socket", async () => {
  const d = deployment()
  const { socket } = await connect(d)
  await d.box.hub.webSocketMessage(socket, new TextEncoder().encode("p").buffer)
  expect(socket.closed).toEqual({ code: 1008, reason: "protocol" })
})

test("a socket's worst-case record and attachment stay inside the platform limits", async () => {
  const ring = await createKeyring({ secrets: [SECRET], appId: APP_ID, ttl: 600 })
  // At most 3 grants of 64 keys each, and a subject of 1024 characters that each escape in JSON.
  const tags = await Promise.all(Array.from({ length: 192 }, (_, i) => ring.tag(`k${i}`)))
  const record = { sub: "\u0001".repeat(1024), exp: Number.MAX_SAFE_INTEGER, tags }
  expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBeLessThan(
    MAX_SOCKET_RECORD_BYTES,
  )
  const most = Number.MAX_SAFE_INTEGER
  const attachment = ["f".repeat(32), most, most, most, most, most]
  expect(new TextEncoder().encode(JSON.stringify(attachment)).byteLength).toBeLessThan(
    MAX_ATTACHMENT_BYTES,
  )
})

test("the hub's membership budget refuses a watch past it", async () => {
  const d = deployment({ maxMemberships: 1 })
  const first = await connect(d)
  await watch(d, first.socket, 1, [(await load(d, first.sid)).grant])
  expect(first.socket.closed).toBeUndefined()
  const second = await connect(d)
  await watch(d, second.socket, 1, [(await load(d, second.sid, "2")).grant])
  expect(second.socket.closed).toEqual({ code: 1013, reason: "at capacity" })
  const Refused = liveHub({ secret: SECRET, maxMemberships: 0 })
  expect(() => new Refused(new FakeState(), {})).toThrow(
    "`maxMemberships` must be a positive whole number",
  )
})

test("a load keeps an owner only while the hub says its grant and keys stand", async () => {
  const d = deployment()
  const { sid } = await connect(d)
  const first = await load(d, sid)
  // Nothing revoked: the page the grant holds is kept without running its loader.
  const kept = await load(d, sid, "1", "alice", { grant: first.grant, retain: [PAGE] })
  expect(kept.page).toBe("retained")
  await d.runtime.revokeKey("post:1", "alice")
  const keyGone = await load(d, sid, "1", "alice", { grant: kept.grant, retain: [PAGE] })
  expect(keyGone.page).toBeUndefined()
  await d.runtime.revoke("alice")
  const grantGone = await load(d, sid, "1", "alice", { grant: keyGone.grant, retain: [PAGE] })
  expect(grantGone.page).toBeUndefined()
  expect(grantGone.grant).toBeString()
})

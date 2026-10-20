import { afterEach, expect, jest, setSystemTime, test } from "bun:test"
import type { NifraWebSocket } from "@nifrajs/core/server"
import { nextSeq } from "../src/live/bus.ts"
import { History, keyHasher } from "../src/live/history.ts"
import {
  CLOSE_BAD_GRANT,
  CLOSE_CAPACITY,
  CLOSE_PROTOCOL,
  CLOSE_REVOKED,
  CLOSE_SCOPE,
  COALESCE_MS,
  type HubOptions,
  IDLE_MS,
  LiveHub,
  type LiveSocket,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_MINUTE,
  MAX_OUTBOUND_BYTES,
  MAX_WATCHES_PER_MINUTE,
} from "../src/live/hub.ts"
import {
  createKeyring,
  type GrantInput,
  type Keyring,
  type LiveSecrets,
} from "../src/live/keyring.ts"
import { Revocations } from "../src/live/revocations.ts"

const SECRET = "hub-test-secret-0123456789abcdef-01"
const OLD_SECRET = "hub-test-secret-0123456789abcdef-02"
const APP_ID = "hub-app"
const SELF = "https://app.test"
const SOCKET_URL = `${SELF}/_nifra/live`

afterEach(() => {
  jest.useRealTimers()
  setSystemTime()
})

class FakeSocket implements NifraWebSocket<LiveSocket> {
  readonly sent: string[] = []
  readonly topics = new Set<string>()
  closed: { code: number; reason: string } | undefined
  readyState = 1
  buffered = 0
  readonly raw = { getBufferedAmount: () => this.buffered }
  constructor(public data: LiveSocket) {}
  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (this.readyState === 1) this.sent.push(String(data))
  }
  close(code = 1000, reason = ""): void {
    if (this.closed === undefined) this.closed = { code, reason }
    this.readyState = 3
  }
  subscribe(topic: string): void {
    this.topics.add(topic)
  }
  unsubscribe(topic: string): void {
    this.topics.delete(topic)
  }
}

interface Rig {
  readonly ring: Keyring
  readonly history: History
  readonly revocations: Revocations
  readonly hub: LiveHub
  readonly sockets: FakeSocket[]
  readonly published: { topic: string; frame: string }[]
  readonly hash: (key: string) => number
}

interface RigOptions extends Partial<HubOptions> {
  readonly secrets?: LiveSecrets
  readonly ring?: (ring: Keyring) => Keyring
  readonly historyEntries?: number
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  const real = await createKeyring({
    secrets: options.secrets ?? [SECRET],
    appId: APP_ID,
    ttl: 600,
  })
  const ring = options.ring?.(real) ?? real
  const head = nextSeq(0, Date.now())
  const history = new History(head, options.historyEntries)
  const revocations = new Revocations(head, 600_000)
  const sockets: FakeSocket[] = []
  const published: { topic: string; frame: string }[] = []
  const hash = keyHasher()
  const hub = new LiveHub(
    ring,
    history,
    revocations,
    {
      appId: APP_ID,
      trusted: new Set(),
      maxSockets: 100,
      maxRssBytes: undefined,
      reloadRate: 500,
      instances: 1,
      spreadFloor: 0,
      hash,
      ...options,
    },
    [
      (topic, frame) => {
        published.push({ topic, frame })
        for (const socket of sockets) if (socket.topics.has(topic)) socket.send(frame)
      },
    ],
  )
  return { ring, history, revocations, hub, sockets, published, hash }
}

function connect(r: Rig, origin: string | null = SELF): FakeSocket {
  const headers: Record<string, string> = origin === null ? {} : { origin }
  const data = r.hub.upgrade(new Request(SOCKET_URL, { headers }))
  if (data instanceof Response) throw new Error(`handshake refused: ${data.status}`)
  const ws = new FakeSocket(data)
  r.sockets.push(ws)
  r.hub.open(ws)
  return ws
}

type Owners = Record<string, readonly string[]>

async function grantFor(
  r: Rig,
  ws: FakeSocket,
  owners: Owners,
  extra: Partial<GrantInput> = {},
  ring: Keyring = r.ring,
  nowMs = Date.now(),
): Promise<string> {
  const watermark = extra.s ?? r.history.last
  const token = await ring.seal(
    {
      sid: ws.data.sid,
      sub: "alice",
      path: "/posts/1",
      frame: "page",
      owners: Object.fromEntries(
        Object.entries(owners).map(([id, k]) => [id, { k: [...k], w: watermark }]),
      ),
      s: r.history.last,
      r: 0,
      ...extra,
    },
    nowMs,
  )
  if (token === undefined) throw new Error("grant not sealed")
  return token
}

const watch = (
  r: Rig,
  ws: FakeSocket,
  gen: number,
  grants: readonly string[],
): Promise<void> | undefined => r.hub.message(ws, JSON.stringify({ t: "watch", gen, grants }))

/** Apply a change the way the runtime does: derive tags, then record and fan out in one step. */
async function change(r: Rig, ...keys: string[]): Promise<number> {
  const tags = await Promise.all(keys.map((key) => r.hub.tagsOf(key)))
  const seq = nextSeq(r.history.last, Date.now())
  r.history.record(seq, keys.map(r.hash), Date.now())
  r.hub.change(keys, tags)
  return seq
}

async function revoke(r: Rig, sub: string | null, key: string | null): Promise<number> {
  const tags = key === null ? [] : await r.hub.tagsOf(key)
  const seq = nextSeq(r.history.last, Date.now())
  r.revocations.apply({ type: "revoke", sub, key, seq }, Date.now())
  r.history.advance(seq, Date.now())
  r.hub.revoke({ type: "revoke", sub, key }, tags)
  return seq
}

type Frame = Record<string, unknown>
const frames = (ws: FakeSocket): Frame[] =>
  ws.sent.filter((text) => text !== "p").map((text) => JSON.parse(text))
const changed = (ws: FakeSocket): Frame[] => frames(ws).filter((frame) => frame.t === "changed")
const readies = (ws: FakeSocket): Frame[] => frames(ws).filter((frame) => frame.t === "ready")
const topic = (tag: string): string => `nifra:live:${APP_ID}:${tag}`

/** A watched socket: `owners` installed under one grant at gen 1. */
async function watched(
  r: Rig,
  owners: Owners,
  extra: Partial<GrantInput> = {},
): Promise<FakeSocket> {
  const ws = connect(r)
  await watch(r, ws, 1, [await grantFor(r, ws, owners, extra)])
  expect(readies(ws)).toEqual([{ t: "ready", gen: 1, stale: [[]] }])
  return ws
}

// --- Handshake ---------------------------------------------------------------------------------

test("welcome carries a fresh 128-bit socket id", async () => {
  const r = await rig()
  const a = connect(r)
  const b = connect(r)
  const [welcomeA] = frames(a)
  const [welcomeB] = frames(b)
  expect(welcomeA?.t).toBe("welcome")
  expect(String(welcomeA?.sid)).toMatch(/^[0-9a-f]{32}$/)
  expect(welcomeA?.sid).toBe(a.data.sid)
  expect(welcomeB?.sid).not.toBe(welcomeA?.sid)
  expect(r.hub.size).toBe(2)
})

test("the handshake refuses a missing, null, untrusted or downgraded Origin", async () => {
  const r = await rig({ trusted: new Set(["https://partner.test"]) })
  for (const origin of [null, "null", "https://evil.test", "http://app.test", "not a url"]) {
    const headers: Record<string, string> = origin === null ? {} : { origin }
    const refused = r.hub.upgrade(new Request(SOCKET_URL, { headers }))
    expect(refused instanceof Response ? refused.status : 0).toBe(403)
  }
  expect(r.hub.upgrade(new Request(SOCKET_URL, { headers: { origin: SELF } }))).not.toBeInstanceOf(
    Response,
  )
  expect(
    r.hub.upgrade(new Request(SOCKET_URL, { headers: { origin: "https://partner.test" } })),
  ).not.toBeInstanceOf(Response)
  // Behind a TLS-terminating proxy the socket's own URL says http.
  expect(
    r.hub.upgrade(new Request("http://app.test/_nifra/live", { headers: { origin: SELF } })),
  ).not.toBeInstanceOf(Response)
})

test("a heartbeat is answered with a heartbeat", async () => {
  const r = await rig()
  const ws = connect(r)
  expect(r.hub.message(ws, "p")).toBeUndefined()
  expect(ws.sent.at(-1)).toBe("p")
})

// --- Install and fan-out -----------------------------------------------------------------------

test("a watch subscribes to the grant's tags and answers ready", async () => {
  const r = await rig()
  const ws = await watched(r, { "P:posts/[id]": ["post:1", "comments:1"] })
  expect([...ws.topics].sort()).toEqual(
    [topic(await r.ring.tag("post:1")), topic(await r.ring.tag("comments:1"))].sort(),
  )
})

test("a socket receives only the tags of keys its grants hold", async () => {
  const r = await rig()
  const a = await watched(r, { "P:a": ["post:1"] })
  const b = await watched(r, { "P:b": ["post:2"] })
  await change(r, "post:1")
  expect(changed(a)).toEqual([{ t: "changed", tag: await r.ring.tag("post:1"), spread: 0 }])
  expect(changed(b)).toEqual([])
  // A key nobody here watches publishes nothing at all.
  const before = r.published.length
  await change(r, "post:3")
  expect(r.published.length).toBe(before)
})

test("changed frames are identical bytes for every subscriber and carry no key, seq or subject", async () => {
  const r = await rig()
  const a = await watched(r, { "P:a": ["post:1"] })
  const b = await watched(r, { "P:a": ["post:1"] }, { sub: "bob" })
  const seq = await change(r, "post:1")
  const frameA = a.sent.at(-1) ?? ""
  expect(b.sent.at(-1)).toBe(frameA)
  expect(Object.keys(JSON.parse(frameA)).sort()).toEqual(["spread", "t", "tag"])
  for (const secret of ["post:1", String(seq), "alice", "bob"]) {
    for (const text of [...a.sent, ...b.sent]) expect(text.includes(secret)).toBe(false)
  }
})

test("every change goes out under the tag of each listed secret that has a local subscriber", async () => {
  const r = await rig({ secrets: [SECRET, OLD_SECRET] })
  const old = await createKeyring({ secrets: [OLD_SECRET], appId: APP_ID, ttl: 600 })
  const fresh = await watched(r, { "P:a": ["post:1"] })
  const demoted = connect(r)
  await watch(r, demoted, 1, [await grantFor(r, demoted, { "P:a": ["post:1"] }, {}, old)])
  expect([...demoted.topics]).toEqual([topic(await old.tag("post:1"))])
  await change(r, "post:1")
  expect(r.published.map((entry) => entry.topic)).toEqual([
    topic(await r.ring.tag("post:1", 0)),
    topic(await r.ring.tag("post:1", 1)),
  ])
  expect(changed(fresh)).toEqual([{ t: "changed", tag: await r.ring.tag("post:1", 0), spread: 0 }])
  // The demoted secret's subscriber still hears it.
  expect(changed(demoted)).toEqual([{ t: "changed", tag: await old.tag("post:1"), spread: 0 }])
  // A topic with no subscriber in this process is not published at all.
  await revoke(r, null, null)
  const before = r.published.length
  await change(r, "post:2")
  expect(r.published.length).toBe(before)
})

test("rotation: a grant under a demoted secret keeps receiving until it expires", async () => {
  const r = await rig({ secrets: [SECRET, OLD_SECRET] })
  const old = await createKeyring({ secrets: [OLD_SECRET], appId: APP_ID, ttl: 600 })
  const ws = connect(r)
  const issued = Date.now()
  await watch(r, ws, 1, [await grantFor(r, ws, { "P:a": ["post:1"] }, {}, old, issued)])
  setSystemTime(new Date(issued + 599_000))
  r.hub.message(ws, "p")
  r.hub.sweep()
  expect(ws.closed).toBeUndefined()
  await change(r, "post:1")
  expect(changed(ws).length).toBe(1)
  setSystemTime(new Date(Math.floor(issued / 1000) * 1000 + 600_000))
  r.hub.sweep()
  expect(ws.closed?.code).toBe(CLOSE_BAD_GRANT)
})

test("ready marks exactly the owners whose keys changed after their watermark", async () => {
  const r = await rig()
  const ws = connect(r)
  const grant = await grantFor(r, ws, { "L:root": ["site:nav"], "P:a": ["post:1"] })
  await change(r, "post:1")
  await watch(r, ws, 1, [grant])
  expect(readies(ws)).toEqual([{ t: "ready", gen: 1, stale: [["P:a"]] }])
})

test("a watermark outside the recorded history marks the owner stale", async () => {
  const r = await rig({ historyEntries: 2 })
  const ws = connect(r)
  const early = await grantFor(r, ws, { "L:root": ["site:nav"] })
  await change(r, "a:1")
  await change(r, "a:2")
  await change(r, "a:3")
  // The oldest entry left the ring: anything at or below it is unknown.
  expect(r.history.known(r.history.floor - 1)).toBe(false)
  await watch(r, ws, 1, [early])
  expect(readies(ws).at(-1)).toEqual({ t: "ready", gen: 1, stale: [["L:root"]] })
  // A watermark this process has not reached yet (another process ran ahead) is unknown too.
  const ahead = await grantFor(r, ws, { "L:root": ["site:nav"] }, { s: r.history.last + 1 })
  await watch(r, ws, 2, [ahead])
  expect(readies(ws).at(-1)).toEqual({ t: "ready", gen: 2, stale: [["L:root"]] })
})

test("history entries older than two minutes are pruned and read as unknown", async () => {
  const r = await rig()
  const ws = connect(r)
  const start = Date.now()
  const grant = await grantFor(r, ws, { "L:root": ["site:nav"] })
  await change(r, "other:1")
  setSystemTime(new Date(start + 121_000))
  await change(r, "other:2")
  await watch(r, ws, 1, [grant])
  expect(readies(ws).at(-1)).toEqual({ t: "ready", gen: 1, stale: [["L:root"]] })
})

test("an event while a watch installs is reported in ready.stale, and ready precedes later frames", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const r = await rig({
    ring: (ring) => ({ ...ring, open: async (token, now) => ring.open(token, (await gate, now)) }),
  })
  const ws = connect(r)
  const grant = await grantFor(r, ws, { "P:a": ["post:1"] })
  jest.useFakeTimers()
  const installing = watch(r, ws, 1, [grant])
  // Applied after the watch arrived but before it subscribed: no frame can reach the socket yet.
  await change(r, "post:1")
  expect(changed(ws)).toEqual([])
  release()
  await installing
  expect(frames(ws).map((frame) => frame.t)).toEqual(["welcome", "ready"])
  expect(readies(ws)).toEqual([{ t: "ready", gen: 1, stale: [["P:a"]] }])
  jest.advanceTimersByTime(COALESCE_MS)
  await change(r, "post:1")
  expect(frames(ws).map((frame) => frame.t)).toEqual(["welcome", "ready", "changed"])
})

test("a lower or repeated gen is ignored, and a newer watch supersedes one still installing", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const r = await rig({
    ring: (ring) => ({ ...ring, open: async (token, now) => ring.open(token, (await gate, now)) }),
  })
  const ws = connect(r)
  const grant = await grantFor(r, ws, { "P:a": ["post:1"] })
  const third = watch(r, ws, 3, [grant])
  const fourth = watch(r, ws, 4, [grant])
  expect(watch(r, ws, 2, [grant])).toBeUndefined()
  expect(watch(r, ws, 4, [grant])).toBeUndefined()
  release()
  await Promise.all([third, fourth])
  expect(readies(ws)).toEqual([{ t: "ready", gen: 4, stale: [[]] }])
})

test("a watch replaces the socket's frames: dropped tags stop arriving", async () => {
  const r = await rig()
  const ws = await watched(r, { "P:a": ["post:1"] })
  await watch(r, ws, 2, [await grantFor(r, ws, { "P:a": ["post:2"] })])
  await change(r, "post:1")
  expect(changed(ws)).toEqual([])
  await change(r, "post:2")
  expect(changed(ws).length).toBe(1)
  // An empty watch leaves every topic.
  await watch(r, ws, 3, [])
  expect(ws.topics.size).toBe(0)
})

// --- Grants and scope --------------------------------------------------------------------------

test("a grant for another socket, a forged, tampered, expired or future-hour grant closes 4401", async () => {
  const r = await rig()
  const other = connect(r)
  const now = Date.now()
  const cases: ((ws: FakeSocket) => Promise<string>)[] = [
    () => grantFor(r, other, { "P:a": ["post:1"] }),
    async () => "not-a-grant",
    async (ws) => {
      const token = await grantFor(r, ws, { "P:a": ["post:1"] })
      const flip = token.charAt(40) === "A" ? "B" : "A"
      return token.slice(0, 40) + flip + token.slice(41)
    },
    (ws) => grantFor(r, ws, { "P:a": ["post:1"] }, {}, r.ring, now - 601_000),
    (ws) => grantFor(r, ws, { "P:a": ["post:1"] }, {}, r.ring, now + 2 * 3_600_000),
    async (ws) =>
      grantFor(
        r,
        ws,
        { "P:a": ["post:1"] },
        {},
        await createKeyring({ secrets: [SECRET], appId: "another-app", ttl: 600 }),
      ),
  ]
  for (const make of cases) {
    const ws = connect(r)
    await watch(r, ws, 1, [await make(ws)])
    expect(ws.closed?.code).toBe(CLOSE_BAD_GRANT)
    expect(ws.topics.size).toBe(0)
  }
})

test("the first accepted grant binds the socket's subject; another subject closes 4409", async () => {
  const r = await rig()
  const ws = await watched(r, { "P:a": ["post:1"] })
  await watch(r, ws, 2, [await grantFor(r, ws, { "P:a": ["post:1"] }, { sub: "bob" })])
  expect(ws.closed?.code).toBe(CLOSE_SCOPE)

  const mixed = connect(r)
  await watch(r, mixed, 1, [
    await grantFor(r, mixed, { "P:a": ["post:1"] }),
    await grantFor(r, mixed, { "P:b": ["post:2"] }, { sub: "bob", path: "/photos/2" }),
  ])
  expect(mixed.closed?.code).toBe(CLOSE_SCOPE)

  const anonymous = await watched(r, { "P:a": ["post:1"] }, { sub: null })
  await watch(r, anonymous, 2, [await grantFor(r, anonymous, { "P:a": ["post:1"] })])
  expect(anonymous.closed?.code).toBe(CLOSE_SCOPE)

  // A watch with no grant binds nothing.
  const unbound = connect(r)
  await watch(r, unbound, 1, [])
  await watch(r, unbound, 2, [await grantFor(r, unbound, { "P:a": ["post:1"] }, { sub: "bob" })])
  expect(unbound.closed).toBeUndefined()
  expect(unbound.data.sub).toBe("bob")
})

test("two grants for one path in a watch close 1008", async () => {
  const r = await rig()
  const ws = connect(r)
  const grant = await grantFor(r, ws, { "P:a": ["post:1"] })
  await watch(r, ws, 1, [grant, grant])
  expect(ws.closed?.code).toBe(CLOSE_PROTOCOL)
})

test("a page and an open boundary watch together; ready.stale is per grant, so a shared owner id stays apart", async () => {
  const r = await rig()
  const ws = connect(r)
  const page = await grantFor(r, ws, { "L:root": ["site:nav"], "P:a": ["post:1"] })
  const boundary = await grantFor(
    r,
    ws,
    { "L:root": ["site:footer"], "P:b": ["photo:9"] },
    { path: "/photos/9" },
  )
  await change(r, "site:footer")
  await watch(r, ws, 1, [page, boundary])
  expect(ws.closed).toBeUndefined()
  expect(readies(ws)).toEqual([{ t: "ready", gen: 1, stale: [[], ["L:root"]] }])
})

test("issued-not-installed: revoke and revokeAll refuse a grant before its first watch", async () => {
  const r = await rig()
  const ws = connect(r)
  const grant = await grantFor(r, ws, { "P:a": ["post:1"] })
  await revoke(r, "alice", null)
  await watch(r, ws, 1, [grant])
  expect(ws.closed?.code).toBe(CLOSE_REVOKED)

  const later = connect(r)
  const bobs = await grantFor(r, later, { "P:a": ["post:1"] }, { sub: "bob" })
  await revoke(r, null, null)
  await watch(r, later, 1, [bobs])
  expect(later.closed?.code).toBe(CLOSE_REVOKED)
})

test("issued-not-installed: revokeKey refuses a grant holding the key, for its subject only", async () => {
  const r = await rig()
  const ws = connect(r)
  const holding = await grantFor(r, ws, { "P:a": ["post:1", "post:2"] })
  const other = connect(r)
  const notHolding = await grantFor(r, other, { "P:a": ["post:2"] })
  const bobSocket = connect(r)
  const bobs = await grantFor(r, bobSocket, { "P:a": ["post:1"] }, { sub: "bob" })
  await revoke(r, null, "post:1")
  await watch(r, ws, 1, [holding])
  expect(ws.closed?.code).toBe(CLOSE_BAD_GRANT)
  await watch(r, other, 1, [notHolding])
  expect(readies(other).length).toBe(1)
  await watch(r, bobSocket, 1, [bobs])
  expect(bobSocket.closed?.code).toBe(CLOSE_BAD_GRANT)

  const r2 = await rig()
  const alice = connect(r2)
  const alices = await grantFor(r2, alice, { "P:a": ["post:1"] })
  const bob = connect(r2)
  const bob2 = await grantFor(r2, bob, { "P:a": ["post:1"] }, { sub: "bob" })
  await revoke(r2, "alice", "post:1")
  await watch(r2, alice, 1, [alices])
  expect(alice.closed?.code).toBe(CLOSE_BAD_GRANT)
  await watch(r2, bob, 1, [bob2])
  expect(readies(bob).length).toBe(1)
})

test("a grant issued after a revocation is accepted", async () => {
  const r = await rig()
  await revoke(r, "alice", null)
  await revoke(r, null, "post:1")
  await watched(r, { "P:a": ["post:1"] })
})

test("revokeKey: one terminal changed, then no later frame for the key reaches a revoked socket", async () => {
  const r = await rig()
  const alice = await watched(r, { "P:a": ["post:1", "post:2"] })
  const bob = await watched(r, { "P:a": ["post:1"] }, { sub: "bob" })
  const grant = await grantFor(r, alice, { "P:a": ["post:1", "post:2"] })
  await revoke(r, "alice", "post:1")
  expect(changed(alice).length).toBe(1)
  expect(changed(bob).length).toBe(1)
  jest.useFakeTimers()
  jest.advanceTimersByTime(COALESCE_MS)
  await change(r, "post:1")
  jest.advanceTimersByTime(COALESCE_MS)
  await change(r, "post:1")
  jest.advanceTimersByTime(COALESCE_MS)
  expect(changed(alice).length).toBe(1)
  expect(changed(bob).length).toBe(3)
  // The other key still arrives, and the old grant cannot bring the revoked one back.
  await change(r, "post:2")
  expect(changed(alice).length).toBe(2)
  await watch(r, alice, 2, [grant])
  expect(alice.closed?.code).toBe(CLOSE_BAD_GRANT)
})

test("revokeKey during a coalescing window: the trailing frame skips the revoked socket", async () => {
  const r = await rig()
  const alice = await watched(r, { "P:a": ["post:1"] })
  const bob = await watched(r, { "P:a": ["post:1"] }, { sub: "bob" })
  jest.useFakeTimers()
  await change(r, "post:1")
  await change(r, "post:1")
  await revoke(r, "alice", "post:1")
  jest.advanceTimersByTime(COALESCE_MS)
  // Leading frame, then the terminal one; the trailing frame reaches bob only.
  expect(changed(alice).length).toBe(2)
  expect(changed(bob).length).toBe(3)
  jest.advanceTimersByTime(COALESCE_MS * 4)
  expect(changed(bob).length).toBe(3)
})

test("revoke closes the subject's sockets with 4403; revokeAll closes every socket", async () => {
  const r = await rig()
  const alice = await watched(r, { "P:a": ["post:1"] })
  const bob = await watched(r, { "P:a": ["post:1"] }, { sub: "bob" })
  const unbound = connect(r)
  await revoke(r, "alice", null)
  expect(alice.closed?.code).toBe(CLOSE_REVOKED)
  expect(alice.topics.size).toBe(0)
  expect(bob.closed).toBeUndefined()
  await revoke(r, null, null)
  expect(bob.closed?.code).toBe(CLOSE_REVOKED)
  expect(unbound.closed?.code).toBe(CLOSE_REVOKED)
  expect(r.hub.size).toBe(0)
})

// --- Coalescing and spread ---------------------------------------------------------------------

test("changes to one key coalesce to a leading and a trailing frame per window", async () => {
  const r = await rig()
  const ws = await watched(r, { "P:a": ["post:1", "post:2"] })
  jest.useFakeTimers()
  await change(r, "post:1")
  await change(r, "post:1", "post:2")
  await change(r, "post:1")
  expect(changed(ws).length).toBe(2)
  jest.advanceTimersByTime(COALESCE_MS)
  expect(changed(ws).length).toBe(3)
  jest.advanceTimersByTime(COALESCE_MS)
  jest.advanceTimersByTime(COALESCE_MS)
  expect(changed(ws).length).toBe(3)
  // The window ended: the next change goes out at once.
  await change(r, "post:1")
  expect(changed(ws).length).toBe(4)
})

test("spread rounds the subscriber estimate up to a few steps", async () => {
  const spreadOf = async (options: RigOptions, subscribers: number): Promise<unknown> => {
    const r = await rig(options)
    const sockets: FakeSocket[] = []
    for (let i = 0; i < subscribers; i++) sockets.push(await watched(r, { "P:a": ["post:1"] }))
    await change(r, "post:1")
    return changed(sockets[0] ?? connect(r)).at(-1)?.spread
  }
  expect(await spreadOf({}, 1)).toBe(0)
  expect(await spreadOf({ reloadRate: 1 }, 1)).toBe(1000)
  expect(await spreadOf({ reloadRate: 1, instances: 2 }, 1)).toBe(2000)
  expect(await spreadOf({ reloadRate: 2 }, 3)).toBe(2000)
  expect(await spreadOf({ reloadRate: 1 }, 3)).toBe(5000)
  expect(await spreadOf({ spreadFloor: 300 }, 1)).toBe(500)
})

// --- Protocol and budgets ----------------------------------------------------------------------

test("anything but a heartbeat or a well-formed watch closes 1008", async () => {
  const r = await rig()
  const big = JSON.stringify({ t: "watch", gen: 1, grants: ["x".repeat(MAX_FRAME_BYTES)] })
  const wide = JSON.stringify({ t: "watch", gen: 1, grants: [], pad: "é".repeat(17_000) })
  const frames: (string | Uint8Array)[] = [
    "not json",
    "[]",
    new Uint8Array([1, 2, 3]),
    JSON.stringify({ t: "publish", keys: ["post:1"] }),
    JSON.stringify({ t: "watch", gen: -1, grants: [] }),
    JSON.stringify({ t: "watch", gen: 1.5, grants: [] }),
    JSON.stringify({ t: "watch", gen: 1, grants: "x" }),
    JSON.stringify({ t: "watch", gen: 1, grants: ["a", "b", "c", "d"] }),
    JSON.stringify({ t: "watch", gen: 1, grants: [7] }),
    JSON.stringify({ t: "watch", gen: 1, grants: ["x".repeat(10_241)] }),
    big,
    wide,
  ]
  expect(wide.length).toBeLessThan(MAX_FRAME_BYTES)
  for (const frame of frames) {
    const ws = connect(r)
    r.hub.message(ws, frame)
    expect(ws.closed?.code).toBe(CLOSE_PROTOCOL)
  }
})

test("more than 20 watches or 60 frames a minute close 1008; the window resets", async () => {
  const r = await rig()
  const start = Date.now()
  const ws = connect(r)
  for (let gen = 1; gen <= MAX_WATCHES_PER_MINUTE; gen++) await watch(r, ws, gen, [])
  expect(ws.closed).toBeUndefined()
  setSystemTime(new Date(start + 60_000))
  await watch(r, ws, 100, [])
  expect(ws.closed).toBeUndefined()
  for (let gen = 101; gen < 101 + MAX_WATCHES_PER_MINUTE; gen++) await watch(r, ws, gen, [])
  expect(ws.closed?.code).toBe(CLOSE_PROTOCOL)

  const chatty = connect(r)
  for (let i = 0; i < MAX_FRAMES_PER_MINUTE; i++) r.hub.message(chatty, "p")
  expect(chatty.closed).toBeUndefined()
  r.hub.message(chatty, "p")
  expect(chatty.closed?.code).toBe(CLOSE_PROTOCOL)
})

test("capacity: the socket cap, the RSS cap, an unreachable bus and the topic cap close 1013", async () => {
  const capped = await rig({ maxSockets: 1 })
  connect(capped)
  expect(connect(capped).closed?.code).toBe(CLOSE_CAPACITY)

  const heavy = await rig({ maxRssBytes: 1 })
  expect(connect(heavy).closed?.code).toBe(CLOSE_CAPACITY)
  const roomy = await rig({ maxRssBytes: Number.MAX_SAFE_INTEGER })
  expect(connect(roomy).closed).toBeUndefined()

  const down = await rig()
  const before = connect(down)
  const grant = await grantFor(down, before, { "P:a": ["post:1"] })
  down.hub.down = true
  await watch(down, before, 1, [grant])
  expect(before.closed?.code).toBe(CLOSE_CAPACITY)
  expect(connect(down).closed?.code).toBe(CLOSE_CAPACITY)

  const topics = await rig({ maxTopics: 1 })
  await watched(topics, { "P:a": ["post:1"] })
  await watched(topics, { "P:a": ["post:1"] })
  const third = connect(topics)
  await watch(topics, third, 1, [await grantFor(topics, third, { "P:a": ["post:2"] })])
  expect(third.closed?.code).toBe(CLOSE_CAPACITY)
})

test("the sweep closes expired, silent and slow sockets", async () => {
  const r = await rig()
  const start = Date.now()
  const expiring = await watched(r, { "P:a": ["post:1"] })
  const silent = connect(r)
  const slow = connect(r)
  const fine = connect(r)
  slow.buffered = MAX_OUTBOUND_BYTES + 1
  r.hub.sweep()
  expect(slow.closed?.code).toBe(CLOSE_CAPACITY)
  setSystemTime(new Date(start + IDLE_MS + 1))
  r.hub.message(fine, "p")
  r.hub.message(expiring, "p")
  r.hub.sweep()
  expect(silent.closed?.code).toBe(CLOSE_PROTOCOL)
  expect(fine.closed).toBeUndefined()
  expect(expiring.closed).toBeUndefined()
  setSystemTime(new Date(start + 601_000))
  r.hub.message(fine, "p")
  r.hub.sweep()
  expect(expiring.closed?.code).toBe(CLOSE_BAD_GRANT)
  expect(fine.closed).toBeUndefined()
})

test("a send past the outbound budget closes 1013", async () => {
  const r = await rig()
  const ws = connect(r)
  ws.buffered = MAX_OUTBOUND_BYTES + 1
  r.hub.message(ws, "p")
  expect(ws.closed?.code).toBe(CLOSE_CAPACITY)
})

test("a closed socket leaves its topics, and its tags stop publishing", async () => {
  const r = await rig()
  const ws = await watched(r, { "P:a": ["post:1"] })
  r.hub.close(ws)
  r.hub.close(ws)
  expect(r.hub.size).toBe(0)
  const before = r.published.length
  await change(r, "post:1")
  expect(r.published.length).toBe(before)
})

test("closeAll closes every socket and leaves every topic", async () => {
  const r = await rig()
  const a = await watched(r, { "P:a": ["post:1"] })
  const b = connect(r)
  r.hub.closeAll(CLOSE_CAPACITY, "resync")
  expect(a.closed?.code).toBe(CLOSE_CAPACITY)
  expect(b.closed?.code).toBe(CLOSE_CAPACITY)
  expect(a.topics.size).toBe(0)
})

test("an install that throws closes 1011", async () => {
  const r = await rig({
    ring: (ring) => ({
      ...ring,
      open: async () => {
        throw new Error("boom")
      },
    }),
  })
  const ws = connect(r)
  await watch(r, ws, 1, ["x"])
  expect(ws.closed?.code).toBe(1011)
})

test("a socket closed while its watch installed stays closed and unsubscribed", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const r = await rig({
    ring: (ring) => ({ ...ring, open: async (token, now) => ring.open(token, (await gate, now)) }),
  })
  const ws = connect(r)
  const installing = watch(r, ws, 1, [await grantFor(r, ws, { "P:a": ["post:1"] })])
  ws.close(1000)
  r.hub.close(ws)
  release()
  await installing
  expect(ws.topics.size).toBe(0)
  expect(readies(ws)).toEqual([])
})

test("a revocation that lands while a watch installs is honored", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const r = await rig({
    ring: (ring) => ({ ...ring, open: async (token, now) => ring.open(token, (await gate, now)) }),
  })
  const ws = connect(r)
  const installing = watch(r, ws, 1, [await grantFor(r, ws, { "P:a": ["post:1"] })])
  await revoke(r, null, "post:1")
  release()
  await installing
  expect(ws.closed?.code).toBe(CLOSE_BAD_GRANT)
  expect(ws.topics.size).toBe(0)
})

test("a frame from a socket refused at open is ignored", async () => {
  const r = await rig({ maxSockets: 1 })
  connect(r)
  const refused = connect(r)
  expect(refused.closed?.code).toBe(CLOSE_CAPACITY)
  refused.readyState = 1
  const grant = await grantFor(r, refused, { "P:a": ["post:1"] })
  expect(watch(r, refused, 1, [grant])).toBeUndefined()
  expect(refused.topics.size).toBe(0)
  expect(readies(refused)).toEqual([])
})

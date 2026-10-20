import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test"
import { type LiveBusEvent, memoryBus, nextSeq } from "../src/live/bus.ts"
import { History, keyHasher } from "../src/live/history.ts"
import { createKeyring, type GrantClaims, MAX_SEALS_PER_SUBKEY } from "../src/live/keyring.ts"
import { Revocations } from "../src/live/revocations.ts"

afterEach(() => setSystemTime())

const claims = (s: number, sub: string | null = "alice"): GrantClaims => ({
  v: 1,
  sid: "0".repeat(32),
  sub,
  path: "/",
  frame: "page",
  owners: {},
  s,
  r: 0,
  iat: 0,
  exp: 600,
  aud: "app",
})

test("the in-memory bus numbers events from a microsecond clock that never repeats or runs back", async () => {
  setSystemTime(new Date(1_800_000_000_000))
  const bus = memoryBus()
  const seen: LiveBusEvent[] = []
  const subscription = await bus.subscribe({
    event: (event) => seen.push(event),
    gap: () => {},
    down: () => {},
  })
  expect(subscription.head).toBe(1_800_000_000_000_000)
  const first = await bus.append({ type: "change", keys: ["a:1"] })
  const second = await bus.append({ type: "revoke", sub: "alice", key: null })
  expect(first).toBe(subscription.head + 1)
  expect(second).toBe(first + 1)
  // The clock went back: the seq still moves forward.
  setSystemTime(new Date(1_700_000_000_000))
  expect(await bus.append({ type: "change", keys: [] })).toBe(second + 1)
  setSystemTime(new Date(1_900_000_000_000))
  expect(await bus.append({ type: "change", keys: [] })).toBe(1_900_000_000_000_000)
  expect(seen.map((event) => event.seq)).toEqual([first, second, second + 1, 1_900_000_000_000_000])
  expect(seen[0]).toEqual({ type: "change", keys: ["a:1"], seq: first })
  subscription.close()
  await bus.append({ type: "change", keys: [] })
  expect(seen.length).toBe(4)
  expect(nextSeq(5, 0)).toBe(6)
})

test("history answers per key and watermark, and evicts oldest first at capacity", () => {
  const hash = keyHasher()
  const head = nextSeq(0, Date.now())
  const history = new History(head, 3)
  expect(history.changedSince(hash("a"), head)).toBe(false)
  history.record(head + 1, [hash("a"), hash("b")], Date.now())
  expect(history.changedSince(hash("a"), head)).toBe(true)
  expect(history.changedSince(hash("a"), head + 1)).toBe(false)
  expect(history.changedSince(hash("c"), head)).toBe(false)
  history.record(head + 2, [hash("c"), hash("d")], Date.now())
  // `a` left the ring: anything at or below its seq is unknown now.
  expect(history.floor).toBe(head + 1)
  expect(history.changedSince(hash("b"), head)).toBe(true)
  expect(history.changedSince(hash("b"), head + 1)).toBe(false)
  expect(history.changedSince(hash("d"), head + 1)).toBe(true)
  history.advance(head + 5, Date.now())
  expect(history.known(head + 5)).toBe(true)
  expect(history.known(head + 6)).toBe(false)
  history.reset(head + 9)
  expect(history.known(head + 5)).toBe(false)
  expect(history.changedSince(hash("d"), head + 9)).toBe(false)
})

test("the key hash is seeded per process and spreads", () => {
  const one = keyHasher()
  const two = keyHasher()
  const values = new Set<number>()
  for (let i = 0; i < 10_000; i++) values.add(one(`post:${i}`))
  expect(values.size).toBe(10_000)
  for (const value of values) expect(Number.isSafeInteger(value) && value >= 0).toBe(true)
  expect(one("post:1")).toBe(one("post:1"))
  expect(one("post:1")).not.toBe(two("post:1"))
})

test("revocations refuse older grants by subject, by key and by key for one subject", () => {
  const head = 1000
  const revocations = new Revocations(head, 600_000)
  expect(revocations.grantRevoked(claims(999))).toBe(true)
  expect(revocations.grantRevoked(claims(1000))).toBe(false)
  revocations.apply({ type: "revoke", sub: "alice", key: null, seq: 1010 }, Date.now())
  expect(revocations.grantRevoked(claims(1009))).toBe(true)
  expect(revocations.grantRevoked(claims(1010))).toBe(false)
  expect(revocations.grantRevoked(claims(1009, "bob"))).toBe(false)
  expect(revocations.grantRevoked(claims(1009, null))).toBe(false)
  revocations.apply({ type: "revoke", sub: null, key: "post:1", seq: 1020 }, Date.now())
  expect(revocations.keyRevoked("post:1", claims(1019, null))).toBe(true)
  expect(revocations.keyRevoked("post:1", claims(1020))).toBe(false)
  expect(revocations.keyRevoked("post:2", claims(1019))).toBe(false)
  revocations.apply({ type: "revoke", sub: "bob", key: "post:2", seq: 1030 }, Date.now())
  expect(revocations.keyRevoked("post:2", claims(1029, "bob"))).toBe(true)
  expect(revocations.keyRevoked("post:2", claims(1029, "alice"))).toBe(false)
  expect(revocations.keyRevoked("post:2", claims(1029, null))).toBe(false)
  revocations.apply({ type: "revoke", sub: null, key: null, seq: 1040 }, Date.now())
  expect(revocations.floor).toBe(1040)
  expect(revocations.grantRevoked(claims(1039, "carol"))).toBe(true)
  // A raise never lowers the floor.
  revocations.raise(1)
  expect(revocations.floor).toBe(1040)
})

test("revocations are dropped once every grant they could refuse has expired", () => {
  const start = 1_800_000_000_000
  const revocations = new Revocations(0, 600_000)
  revocations.apply({ type: "revoke", sub: "alice", key: null, seq: 10 }, start)
  revocations.apply({ type: "revoke", sub: "bob", key: null, seq: 20 }, start + 300_000)
  revocations.apply({ type: "revoke", sub: "alice", key: null, seq: 30 }, start + 400_000)
  // Past alice's first entry's horizon, but she was revoked again later: her entry moved to the end.
  revocations.apply({ type: "revoke", sub: null, key: "x:1", seq: 40 }, start + 721_000)
  expect(revocations.grantRevoked(claims(25, "alice"))).toBe(true)
  expect(revocations.grantRevoked(claims(15, "bob"))).toBe(true)
  revocations.apply({ type: "revoke", sub: null, key: "x:2", seq: 50 }, start + 1_021_000)
  expect(revocations.grantRevoked(claims(15, "bob"))).toBe(false)
  expect(revocations.grantRevoked(claims(25, "alice"))).toBe(true)
  revocations.apply({ type: "revoke", sub: null, key: "x:3", seq: 60 }, start + 1_121_000)
  expect(revocations.grantRevoked(claims(25, "alice"))).toBe(false)
  expect(revocations.keyRevoked("x:1", claims(39))).toBe(true)
})

test("past the stored limit, one global revocation replaces every entry", () => {
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    const revocations = new Revocations(0, 600_000, 2)
    revocations.apply({ type: "revoke", sub: "a", key: null, seq: 10 }, Date.now())
    revocations.apply({ type: "revoke", sub: "b", key: null, seq: 20 }, Date.now())
    expect(error).not.toHaveBeenCalled()
    revocations.apply({ type: "revoke", sub: "c", key: "k:1", seq: 30 }, Date.now())
    expect(String(error.mock.calls[0]?.[0])).toContain("more than 2 stored revocations")
    expect(revocations.floor).toBe(30)
    expect(revocations.grantRevoked(claims(29, "z"))).toBe(true)
    expect(revocations.grantRevoked(claims(30, "a"))).toBe(false)
  } finally {
    error.mockRestore()
  }
})

test("each hour's subkey seals at most its limit of grants", async () => {
  expect(MAX_SEALS_PER_SUBKEY).toBe(2 ** 31)
  const ring = await createKeyring({
    secrets: ["seal-limit-secret-0123456789abcdef"],
    appId: "app",
    ttl: 600,
    maxSealsPerSubkey: 2,
  })
  const input = { sid: "0".repeat(32), sub: null, path: "/", frame: "page", owners: {}, s: 0, r: 0 }
  const hour = 1_800_000_000_000 - (1_800_000_000_000 % 3_600_000)
  expect(await ring.seal(input, hour)).toBeString()
  expect(await ring.seal(input, hour + 1000)).toBeString()
  expect(await ring.seal(input, hour + 2000)).toBeUndefined()
  // The next hour is a new subkey with its own count.
  expect(await ring.seal(input, hour + 3_600_000)).toBeString()
})

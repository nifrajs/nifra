/**
 * The Redis Streams live bus: against an in-memory stand-in that runs the append script's steps in
 * JS (every reader path, gap and failure), and against a real `redis-server` when one is installed
 * (the Lua itself, the clock under concurrent appends, a RESP3 reply).
 */
import { afterAll, expect, test } from "bun:test"
import { type LiveBusEvent, type LiveBusListener, live, livePublisher } from "../src/live.ts"
import { type RedisCommand, redisLiveBus } from "../src/live-redis.ts"
import { memoryRedis } from "./memory-redis.ts"

/** A listener recording what the bus tells it. */
function recorder() {
  const seen: (LiveBusEvent | { gap: number } | "down")[] = []
  const causes: unknown[] = []
  const listener: LiveBusListener = {
    event: (event) => seen.push(event),
    gap: (head) => seen.push({ gap: head }),
    down: (error) => {
      seen.push("down")
      causes.push(error)
    },
  }
  return { seen, causes, listener }
}

/** Waits for a condition; the deadline only turns a hang into a failure. */
async function until(ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`[test] never: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

test("appends get rising seqs from the clock; every reader gets every event in order", async () => {
  const redis = memoryRedis()
  const a = redisLiveBus({ ...redis, blockMs: 20 })
  const b = redisLiveBus({ ...redis, blockMs: 20 })
  const first = recorder()
  const second = recorder()
  const subA = await a.subscribe(first.listener)
  const subB = await b.subscribe(second.listener)
  expect(subA.head).toBe(0)
  const before = Date.now() * 1000
  const s1 = await a.append({ type: "change", keys: ["post:1"] })
  const s2 = await b.append({ type: "revoke", sub: "alice", key: null })
  const s3 = await a.append({ type: "revoke", sub: null, key: "post:1" })
  expect(s1).toBeGreaterThanOrEqual(before)
  expect(s2).toBeGreaterThan(s1)
  expect(s3).toBeGreaterThan(s2)
  const expected: LiveBusEvent[] = [
    { type: "change", keys: ["post:1"], seq: s1 },
    { type: "revoke", sub: "alice", key: null, seq: s2 },
    { type: "revoke", sub: null, key: "post:1", seq: s3 },
  ]
  await until(() => first.seen.length === 3 && second.seen.length === 3, "delivery")
  expect(first.seen).toEqual(expected)
  expect(second.seen).toEqual(expected)
  subA.close()
  subB.close()
  // A later subscriber starts after what is already there.
  const late = await a.subscribe(recorder().listener)
  expect(late.head).toBe(s3)
  late.close()
})

test("a reader that fell behind a trim reports the gap, then goes on", async () => {
  const redis = memoryRedis()
  const bus = redisLiveBus({ ...redis, blockMs: 20, maxLength: 2 })
  const { seen, listener } = recorder()
  const sub = await bus.subscribe(listener)
  sub.close()
  // Appended while nobody reads: the first two are trimmed away.
  const seqs: number[] = []
  for (const key of ["a", "b", "c", "d"])
    seqs.push(await bus.append({ type: "change", keys: [key] }))
  const reader = redisLiveBus({ ...redis, blockMs: 20 })
  const again = recorder()
  const resumed = await reader.subscribe(again.listener)
  expect(resumed.head).toBe(seqs[3] ?? 0)
  resumed.close()
  expect(seen).toEqual([])
  // A reader that subscribed before the trim and reads after it.
  const behind = memoryRedis()
  const slow = redisLiveBus({ ...behind, blockMs: 20, maxLength: 2 })
  const watcher = recorder()
  const head = await slow.subscribe(watcher.listener)
  // The parked read wakes on the first append and fails; the rest land, and trim, before its retry.
  behind.failures.read = 1
  const later: number[] = []
  for (const key of ["a", "b", "c", "d"])
    later.push(await slow.append({ type: "change", keys: [key] }))
  await until(() => watcher.seen.length >= 3, "gap then events")
  expect(watcher.seen[0]).toEqual({ gap: (later[2] ?? 0) - 1 })
  expect(watcher.seen.slice(1)).toEqual([
    { type: "change", keys: ["c"], seq: later[2] ?? 0 },
    { type: "change", keys: ["d"], seq: later[3] ?? 0 },
  ])
  head.close()
})

test("one failed read is retried quietly; an outage reports down, then a gap at the clock", async () => {
  const redis = memoryRedis()
  const bus = redisLiveBus({ ...redis, blockMs: 20 })
  const { seen, causes, listener } = recorder()
  const sub = await bus.subscribe(listener)
  redis.failures.read = 1
  const s1 = await bus.append({ type: "change", keys: ["a"] })
  await until(() => seen.length === 1, "after one failure")
  expect(seen).toEqual([{ type: "change", keys: ["a"], seq: s1 }])
  redis.failures.read = 3
  const s2 = await bus.append({ type: "change", keys: ["b"] })
  await until(() => seen.length >= 3, "down then gap")
  expect(seen.slice(1, 3)).toEqual(["down", { gap: s2 }])
  // The read's own failure travels with the outage, so the runtime can say why.
  expect(causes).toHaveLength(1)
  expect(causes[0]).toBeInstanceOf(Error)
  const s3 = await bus.append({ type: "change", keys: ["c"] })
  await until(() => seen.length === 4, "resumed")
  expect(seen[3]).toEqual({ type: "change", keys: ["c"], seq: s3 })
  sub.close()
})

test("an entry that is not a bus event is a gap at its seq; a closed subscription hears nothing", async () => {
  const redis = memoryRedis()
  const bus = redisLiveBus({ ...redis, blockMs: 20 })
  const { seen, listener } = recorder()
  const sub = await bus.subscribe(listener)
  // Below the clock the next append reads, so that append still lands above them.
  let id = Date.now() * 1000 - 100
  redis.push("nifra:live", `${++id}-0`, ["n", "1", "e", "not json"])
  await until(() => seen.length === 1, "malformed")
  expect(seen[0]).toMatchObject({ gap: expect.any(Number) })
  redis.push("nifra:live", `${++id}-0`, [
    "n",
    "2",
    "e",
    JSON.stringify({ type: "change", keys: [1, "k"] }),
  ])
  redis.push("nifra:live", `${++id}-0`, [
    "n",
    "3",
    "e",
    JSON.stringify({ type: "revoke", sub: 5, key: null }),
  ])
  await until(() => seen.length === 3, "filtered")
  expect(seen[1]).toMatchObject({ type: "change", keys: ["k"] })
  expect(seen[2]).toMatchObject({ gap: expect.any(Number) })
  sub.close()
  await bus.append({ type: "change", keys: ["x"] })
  await until(() => redis.reads.pending === 0, "the parked read returned")
  expect(seen).toHaveLength(3)
})

test("RESP2 arrays, RESP3 maps and Map replies read alike; a foreign id moves the cursor on", async () => {
  const redis = memoryRedis()
  const shapes = [
    (reply: unknown) => reply,
    (reply: unknown) =>
      Array.isArray(reply) ? Object.fromEntries(reply.map((pair) => [pair[0], pair[1]])) : reply,
    (reply: unknown) =>
      Array.isArray(reply) ? new Map(reply.map((pair) => [pair[0], pair[1]])) : reply,
  ]
  for (const shape of shapes) {
    const bus = redisLiveBus({
      send: redis.send,
      read: async (command, args) => shape(await redis.read(command, args)),
      blockMs: 20,
    })
    const { seen, listener } = recorder()
    const sub = await bus.subscribe(listener)
    const first = await bus.append({ type: "change", keys: ["a"] })
    // Another writer's entry: no seq of this bus, so a gap at the last one known, and no event.
    redis.push("nifra:live", `${first}-1`, ["x", "y"])
    const second = await bus.append({ type: "change", keys: ["b"] })
    await until(() => seen.length === 3, "the gap and the events")
    expect(seen).toEqual([
      { type: "change", keys: ["a"], seq: first },
      { gap: first },
      { type: "change", keys: ["b"], seq: second },
    ])
    sub.close()
  }
})

test("a reply of no known shape backs off as a failed read; only a read that answers ends the outage", async () => {
  const redis = memoryRedis()
  let reads = 0
  let answering = false
  const bus = redisLiveBus({
    send: redis.send,
    read: async (command, args) => {
      reads++
      return answering ? redis.read(command, args) : "OK"
    },
    blockMs: 20,
  })
  const { seen, listener } = recorder()
  const readsAt: number[] = []
  const sub = await bus.subscribe({
    event: listener.event,
    down: () => {
      readsAt.push(reads)
      listener.down()
    },
    gap: (head) => {
      readsAt.push(reads)
      listener.gap(head)
    },
  })
  await until(() => seen.length === 1, "down")
  // The clock is reachable, but this reader is not: no gap claims it caught up.
  expect(seen).toEqual(["down"])
  answering = true
  // The stand-in's read waits for an append, as a blocking XREAD would until its block time.
  const head = await bus.append({ type: "change", keys: ["a"] })
  await until(() => seen.length === 2, "a gap at the clock once a read answers")
  expect(seen).toEqual(["down", { gap: head }])
  // Two failed reads, then the one that answered: none in between.
  expect(readsAt).toEqual([2, 3])
  sub.close()
})

test("a read that never answers counts as failed: two report down, and the next answer ends it", async () => {
  const redis = memoryRedis()
  let stalls = 2
  const bus = redisLiveBus({
    send: redis.send,
    read: (command, args) => (stalls-- > 0 ? new Promise(() => {}) : redis.read(command, args)),
    blockMs: 20,
    readTimeoutMs: 30,
  })
  const { seen, listener } = recorder()
  const sub = await bus.subscribe(listener)
  const missed = await bus.append({ type: "change", keys: ["a"] })
  await until(() => seen.length === 2, "down, then a gap at the clock")
  expect(seen).toEqual(["down", { gap: missed }])
  const next = await bus.append({ type: "change", keys: ["b"] })
  await until(() => seen.length === 3, "delivery resumed")
  expect(seen[2]).toEqual({ type: "change", keys: ["b"], seq: next })
  sub.close()
})

test("a live runtime on the bus: a publish resolves once this process has read it back", async () => {
  const redis = memoryRedis()
  const runtime = live({
    secret: "redis-bus-secret-0123456789abcdef-01",
    subject: () => null,
    bus: redisLiveBus({ ...redis, blockMs: 20 }),
  })
  await runtime.ready
  await runtime.publish("post:1")
  await runtime.revokeKey("post:1")
  expect(redis.streams.get("nifra:live")).toHaveLength(2)
})

test("a bus with no reader appends, and refuses to subscribe", async () => {
  const redis = memoryRedis()
  const bus = redisLiveBus({ send: redis.send })
  expect(await bus.append({ type: "change", keys: ["a"] })).toBeGreaterThan(0)
  const { listener } = recorder()
  await expect(bus.subscribe(listener)).rejects.toThrow(/`read`/)
})

test("livePublisher: a publish-only process reaches a runtime reading the same stream", async () => {
  const redis = memoryRedis()
  const runtime = live({
    secret: "redis-bus-secret-0123456789abcdef-01",
    subject: () => null,
    bus: redisLiveBus({ ...redis, blockMs: 20 }),
    logger: false,
  })
  await runtime.ready
  const publish = livePublisher(redisLiveBus({ send: redis.send }))
  await publish("post:1", "post:1", "post:2")
  await until(() => runtime.status().events === 1, "the runtime applied the change")
  expect(redis.streams.get("nifra:live")).toHaveLength(1)
  await publish()
  expect(redis.streams.get("nifra:live")).toHaveLength(1)
  await expect(publish("bad key")).rejects.toThrow(TypeError)
  await runtime.close()
})

test("close() stops the reader first: its connection failing afterwards is no outage", async () => {
  const redis = memoryRedis()
  const lines: string[] = []
  const logger = {
    debug() {},
    info() {},
    warn: (message: string) => lines.push(message),
    error: (message: string) => lines.push(message),
  }
  const runtime = live({
    secret: "redis-bus-secret-0123456789abcdef-01",
    subject: () => null,
    bus: redisLiveBus({ ...redis, blockMs: 20 }),
    logger,
  })
  await runtime.ready
  await runtime.close()
  // The parked read wakes on the next append and fails, as a connection closed under it would.
  redis.failures.read = 10
  await redisLiveBus({ send: redis.send }).append({ type: "change", keys: ["a"] })
  await until(() => redis.reads.pending === 0, "the parked read returned")
  expect(redis.failures.read).toBe(9)
  expect(lines).toEqual([])
})

// --- A real server ------------------------------------------------------------------------------------

const redisServer = Bun.which("redis-server")
const spawned: { kill(): void }[] = []
afterAll(() => {
  for (const proc of spawned) proc.kill()
})

test.skipIf(redisServer === null)(
  "on a real redis-server: concurrent appends from two clients keep one strictly rising clock",
  async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    const proc = Bun.spawn(
      [redisServer ?? "", "--port", String(port), "--save", "", "--appendonly", "no"],
      { stdout: "ignore", stderr: "ignore" },
    )
    spawned.push(proc)
    const { RedisClient } = await import("bun")
    const url = `redis://127.0.0.1:${port}`
    const clients = [new RedisClient(url), new RedisClient(url), new RedisClient(url)]
    const [one, two, reader] = clients
    if (one === undefined || two === undefined || reader === undefined) throw new Error("clients")
    for (let attempt = 0; ; attempt++) {
      try {
        await one.send("PING", [])
        break
      } catch (error) {
        if (attempt > 200) throw error
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    const command =
      (client: InstanceType<typeof RedisClient>): RedisCommand =>
      (name, args) =>
        client.send(name, [...args])
    const a = redisLiveBus({
      send: command(one),
      read: command(reader),
      blockMs: 50,
      maxLength: 1000,
    })
    const b = redisLiveBus({ send: command(two), read: command(reader), blockMs: 50 })
    const { seen, listener } = recorder()
    const sub = await a.subscribe(listener)
    const seqs = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        (i % 2 === 0 ? a : b).append({ type: "change", keys: [`k:${i}`] }),
      ),
    )
    expect(new Set(seqs).size).toBe(200)
    await until(() => seen.length === 200, "all read")
    const order = seen.map((entry) => (typeof entry === "object" && "seq" in entry ? entry.seq : 0))
    expect(order).toEqual([...seqs].sort((x, y) => x - y))
    expect(order.every((seq, i) => i === 0 || seq > (order[i - 1] ?? 0))).toBe(true)
    sub.close()
    for (const client of clients) client.close()
  },
)

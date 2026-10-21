import { expect, setSystemTime, test } from "bun:test"
import { server } from "@nifrajs/core"
import {
  type IdempotencyStore,
  idempotency,
  MemoryIdempotencyStore,
  MemoryStore,
  rateLimit,
} from "../src/index.ts"

const post = (path: string) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "idempotency-key": "same" } })

/** The same store seen through another object, as a second process sharing it would see it. */
const viewOf = (memory: MemoryIdempotencyStore): IdempotencyStore => ({
  begin: memory.begin.bind(memory),
  complete: memory.complete.bind(memory),
  release: memory.release.bind(memory),
  renew: memory.renew.bind(memory),
})

test("idempotency rejects installation after a mutating route before it can cache a private answer", () => {
  expect(() =>
    server()
      .post("/protected", () => ({ private: true }))
      .use(idempotency({ store: new MemoryIdempotencyStore() })),
  ).toThrow(/before.*route/)
})

test("a guard registered after idempotency still refuses a replay to a revoked caller", async () => {
  for (const shape of ["hook", "middleware", "group"] as const) {
    let permitted = true
    const guard = () => (permitted ? undefined : new Response("denied", { status: 403 }))
    const base = server().use(idempotency({ store: new MemoryIdempotencyStore() }))
    const handler = () => ({ value: "private" })
    const app =
      shape === "hook"
        ? base.beforeHandle(guard).post("/p", handler)
        : shape === "middleware"
          ? base.use({ name: "guard", beforeHandle: guard }).post("/p", handler)
          : base.group("/g", (g) => g.beforeHandle(guard).post("/p", handler))
    const path = shape === "group" ? "/g/p" : "/p"
    expect((await app.fetch(post(path))).status).toBe(200)
    permitted = false
    const retry = await app.fetch(post(path))
    expect([shape, retry.status, await retry.text()]).toEqual([shape, 403, "denied"])
  }
})

test("a request no covered route handles releases its key instead of storing an unservable record", async () => {
  let mounted = 0
  const app = server()
    .use(idempotency({ store: new MemoryIdempotencyStore() }))
    .mount({ path: "/m", app: { fetch: () => Response.json({ mounted: ++mounted }) } })
  const first = await app.fetch(post("/m/x"))
  const retry = await app.fetch(post("/m/x"))
  expect([first.status, retry.status, mounted]).toEqual([200, 200, 2])
  expect(await retry.json()).toEqual({ mounted: 2 })

  const answered = server()
    .use(idempotency({ store: new MemoryIdempotencyStore() }))
    .use({ name: "early", onRequest: () => Response.json({ early: true }) })
    .post("/p", () => ({ route: true }))
  expect((await answered.fetch(post("/p"))).status).toBe(200)
  const again = await answered.fetch(post("/p"))
  expect([again.status, await again.json()]).toEqual([200, { early: true }])
})

test("an oversized successful mutation retains a terminal replay instead of running twice", async () => {
  let effects = 0
  const app = server()
    .use(idempotency({ store: new MemoryIdempotencyStore(), maxBytes: 8 }))
    .post("/effect", () => ({ effect: ++effects, value: "too large to capture" }))
  expect((await app.fetch(post("/effect"))).status).toBe(200)
  const retry = await app.fetch(post("/effect"))
  expect(retry.status).toBe(507)
  expect(await retry.json()).toEqual({ ok: false, error: "idempotency_response_too_large" })
  expect(effects).toBe(1)
})

test("idempotency renews an active handler's lease", async () => {
  const start = Date.parse("2026-01-01T00:00:00Z")
  const lockTtlMs = 60
  const memory = new MemoryIdempotencyStore()
  const barrier = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const renewed = Promise.withResolvers<void>()
  let renewals = 0
  let effects = 0
  const store: IdempotencyStore = {
    ...viewOf(memory),
    async renew(key, reservation, ttl) {
      // The first renewal lands just before the first lease ends, so past that point only the
      // renewal holds the key.
      if (++renewals === 1) setSystemTime(start + lockTtlMs - 1)
      const owned = await memory.renew(key, reservation, ttl)
      renewed.resolve()
      return owned
    },
  }
  const handler = async () => {
    effects++
    entered.resolve()
    await barrier.promise
    return { ok: true }
  }
  const app = server().use(idempotency({ store, lockTtlMs })).post("/slow", handler)
  const elsewhere = server()
    .use(idempotency({ store: viewOf(memory), lockTtlMs }))
    .post("/slow", () => ({ effect: ++effects }))
  setSystemTime(start)
  const first = app.fetch(post("/slow"))
  try {
    await entered.promise
    await renewed.promise
    setSystemTime(start + lockTtlMs + 40)
    expect((await app.fetch(post("/slow"))).status).toBe(409)
    expect((await elsewhere.fetch(post("/slow"))).status).toBe(409)
    expect(effects).toBe(1)
    barrier.resolve()
    expect((await first).status).toBe(200)
    expect((await app.fetch(post("/slow"))).status).toBe(200)
    expect(effects).toBe(1)
  } finally {
    barrier.resolve()
    await first
    setSystemTime()
  }
})

test("a renewal the store cannot confirm loses the reservation instead of reporting success", async () => {
  const memory = new MemoryIdempotencyStore()
  const failed = Promise.withResolvers<void>()
  let effects = 0
  const app = server()
    .use(
      idempotency({
        store: {
          ...viewOf(memory),
          renew: async () => {
            failed.resolve()
            throw new Error("synthetic store outage")
          },
        },
        lockTtlMs: 3,
      }),
    )
    .post("/effect", async () => {
      effects++
      await failed.promise
      return { ok: true }
    })
  const response = await app.fetch(post("/effect"))
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ ok: false, error: "idempotency_reservation_lost" })
  expect(effects).toBe(1)
})

test("a lost idempotency completion cannot be reported as success", async () => {
  const memory = new MemoryIdempotencyStore()
  const app = server()
    .use(
      idempotency({
        store: {
          begin: memory.begin.bind(memory),
          release: memory.release.bind(memory),
          complete: async () => false,
        },
      }),
    )
    .post("/effect", () => ({ ok: true }))
  const response = await app.fetch(post("/effect"))
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ ok: false, error: "idempotency_reservation_lost" })
})

test("old replay records without an admission marker never bypass authentication", async () => {
  const app = server()
    .use(
      idempotency({
        store: {
          begin: async () => ({
            state: "replay",
            record: { status: 200, headers: [], body: btoa("private") },
          }),
          complete: async () => true,
          release: async () => true,
        },
      }),
    )
    .post("/private", () => "must not run")
  const response = await app.fetch(post("/private"))
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain("private")
})

test("stores without renewal keep a pending reservation for at least the replay retention", async () => {
  const memory = new MemoryIdempotencyStore()
  let lease = 0
  const app = server()
    .use(
      idempotency({
        store: {
          begin: (key, ttl) => {
            lease = ttl
            return memory.begin(key, ttl)
          },
          complete: memory.complete.bind(memory),
          release: memory.release.bind(memory),
        },
        lockTtlMs: 20,
        ttlMs: 1_000,
      }),
    )
    .post("/effect", () => ({ ok: true }))
  expect((await app.fetch(post("/effect"))).status).toBe(200)
  expect(lease).toBe(1_000)
})

test("a failed response-body capture keeps a terminal record instead of repeating an effect", async () => {
  let effects = 0
  const app = server({ logger: { error() {}, warn() {}, info() {}, debug() {} } })
    .use(idempotency({ store: new MemoryIdempotencyStore() }))
    .post("/effect", () => {
      effects++
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("synthetic"))
          },
        }),
      )
    })
  await expect(app.fetch(post("/effect"))).rejects.toThrow("synthetic")
  const retry = await app.fetch(post("/effect"))
  expect(retry.status).toBe(500)
  expect(effects).toBe(1)
})

test("limiter overflow refuses new keys without resetting an exhausted live quota", async () => {
  const app = server()
    .use(
      rateLimit({
        store: new MemoryStore({ maxKeys: 2 }),
        max: 1,
        windowMs: 60_000,
        key: (request) => request.headers.get("x-test-key") ?? "",
      }),
    )
    .get("/", () => "ok")
  const send = (key: string) =>
    app.fetch(new Request("http://x/", { headers: { "x-test-key": key } }))
  expect((await send("A")).status).toBe(200)
  expect((await send("A")).status).toBe(429)
  expect((await send("B")).status).toBe(200)
  expect((await send("C")).status).toBe(429)
  expect((await send("A")).status).toBe(429)
})

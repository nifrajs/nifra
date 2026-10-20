import { expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { idempotency, MemoryIdempotencyStore, MemoryStore, rateLimit } from "../src/index.ts"

const post = (path: string) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "idempotency-key": "same" } })

test("idempotency rejects installation after a mutating route before it can cache a private answer", () => {
  expect(() =>
    server()
      .post("/protected", () => ({ private: true }))
      .use(idempotency({ store: new MemoryIdempotencyStore() })),
  ).toThrow(/before.*route/)
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
  let release!: () => void
  let started!: () => void
  let effects = 0
  let renewals = 0
  const store = new MemoryIdempotencyStore()
  const renew = store.renew.bind(store)
  store.renew = async (...args) => {
    renewals++
    return renew(...args)
  }
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const app = server()
    .use(idempotency({ store, lockTtlMs: 60 }))
    .post("/slow", async () => {
      effects++
      started()
      await barrier
      return { ok: true }
    })
  const first = app.fetch(post("/slow"))
  let retry: ReturnType<typeof app.fetch> | undefined
  try {
    await entered
    await Bun.sleep(180)
    retry = app.fetch(post("/slow"))
    const response = await Promise.race([retry, Bun.sleep(50).then(() => undefined)])
    expect(response?.status).toBe(409)
    expect(effects).toBe(1)
    expect(renewals).toBeGreaterThan(0)
  } finally {
    release()
    await Promise.allSettled([first, retry])
  }
  expect((await first).status).toBe(200)
  expect((await app.fetch(post("/slow"))).status).toBe(200)
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

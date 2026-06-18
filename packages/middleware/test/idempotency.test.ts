import { afterEach, describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { type IdempotencyOptions, idempotency, MemoryIdempotencyStore } from "../src/index.ts"

function counterApp(
  options: Omit<IdempotencyOptions, "store"> & { store: MemoryIdempotencyStore },
) {
  let calls = 0
  const app = server()
    .use(idempotency(options))
    .post("/pay", () => {
      calls += 1
      return new Response(JSON.stringify({ charge: calls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
  return { app, calls: () => calls }
}

const post = (key?: string): Request =>
  new Request("http://x/pay", {
    method: "POST",
    body: "{}",
    headers: key === undefined ? {} : { "idempotency-key": key },
  })

describe("idempotency middleware", () => {
  test("replays the first response on a retry with the same key — handler runs once", async () => {
    const { app, calls } = counterApp({ store: new MemoryIdempotencyStore() })

    const first = await app.fetch(post("k1"))
    const firstBody = await first.json()
    expect(firstBody).toEqual({ charge: 1 })
    expect(first.headers.get("idempotent-replayed")).toBeNull()

    const second = await app.fetch(post("k1"))
    expect(await second.json()).toEqual({ charge: 1 }) // same body, NOT { charge: 2 }
    expect(second.status).toBe(200)
    expect(second.headers.get("idempotent-replayed")).toBe("true")
    expect(calls()).toBe(1) // the side effect ran exactly once
  })

  test("distinct keys run independently", async () => {
    const { app, calls } = counterApp({ store: new MemoryIdempotencyStore() })
    expect(await (await app.fetch(post("a"))).json()).toEqual({ charge: 1 })
    expect(await (await app.fetch(post("b"))).json()).toEqual({ charge: 2 })
    expect(calls()).toBe(2)
  })

  test("no key ⇒ pass-through (the handler runs every time, nothing is cached)", async () => {
    const { app, calls } = counterApp({ store: new MemoryIdempotencyStore() })
    await app.fetch(post())
    await app.fetch(post())
    expect(calls()).toBe(2)
  })

  test("safe methods are ignored even with a key", async () => {
    let gets = 0
    const app = server()
      .use(idempotency({ store: new MemoryIdempotencyStore() }))
      .get("/", () => {
        gets += 1
        return "ok"
      })
    const withKey = (): Request => new Request("http://x/", { headers: { "idempotency-key": "g" } })
    await app.fetch(withKey())
    await app.fetch(withKey())
    expect(gets).toBe(2) // GET never deduped
  })

  test("a concurrent in-flight request gets a 409 (not a double-run)", async () => {
    const store = new MemoryIdempotencyStore()
    await store.begin("busy", 60_000) // simulate another instance/request holding the lock
    const { app, calls } = counterApp({ store })

    const res = await app.fetch(post("busy"))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: "idempotency_in_progress" })
    expect(res.headers.get("retry-after")).not.toBeNull()
    expect(calls()).toBe(0) // the handler never ran
  })

  test("a 5xx is not cached — the lock releases so a retry re-runs the handler", async () => {
    let calls = 0
    const app = server()
      .use(idempotency({ store: new MemoryIdempotencyStore() }))
      .post("/flaky", () => {
        calls += 1
        return new Response("upstream down", { status: 503 })
      })
    const flaky = (): Request =>
      new Request("http://x/flaky", {
        method: "POST",
        body: "{}",
        headers: { "idempotency-key": "r" },
      })

    expect((await app.fetch(flaky())).status).toBe(503)
    expect((await app.fetch(flaky())).status).toBe(503)
    expect(calls).toBe(2) // transient 5xx must be retryable, not replayed
  })

  test("Set-Cookie is not cached or replayed (avoids leaking a session to a second caller)", async () => {
    const app = server()
      .use(idempotency({ store: new MemoryIdempotencyStore() }))
      .post("/login", () => {
        return new Response("ok", {
          status: 200,
          headers: { "set-cookie": "sid=secret-session; Path=/; HttpOnly" },
        })
      })
    const login = (): Request =>
      new Request("http://x/login", {
        method: "POST",
        body: "{}",
        headers: { "idempotency-key": "s" },
      })

    const first = await app.fetch(login())
    expect(first.headers.get("set-cookie")).toContain("sid=secret-session") // first caller gets the cookie

    const replayed = await app.fetch(login())
    expect(replayed.headers.get("idempotent-replayed")).toBe("true")
    expect(replayed.headers.get("set-cookie")).toBeNull() // replay must NOT carry the cookie
    expect(await replayed.text()).toBe("ok")
  })

  test("an over-maxBytes response is returned but not cached", async () => {
    let calls = 0
    const app = server()
      .use(idempotency({ store: new MemoryIdempotencyStore(), maxBytes: 8 }))
      .post("/big", () => {
        calls += 1
        return new Response("x".repeat(64), { status: 200 })
      })
    const big = (): Request =>
      new Request("http://x/big", {
        method: "POST",
        body: "{}",
        headers: { "idempotency-key": "z" },
      })

    expect((await app.fetch(big())).status).toBe(200)
    expect((await app.fetch(big())).status).toBe(200)
    expect(calls).toBe(2) // too large to cache ⇒ each call re-runs
  })

  test("an over-maxBytes streamed response is returned intact without replay caching", async () => {
    const enc = new TextEncoder()
    let calls = 0
    const app = server()
      .use(idempotency({ store: new MemoryIdempotencyStore(), maxBytes: 4 }))
      .post("/stream", () => {
        calls += 1
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(enc.encode("12345"))
            },
            pull(controller) {
              controller.enqueue(enc.encode("67890"))
              controller.close()
            },
          }),
        )
      })
    const stream = (): Request =>
      new Request("http://x/stream", {
        method: "POST",
        body: "{}",
        headers: { "idempotency-key": "stream" },
      })

    expect(await (await app.fetch(stream())).text()).toBe("1234567890")
    expect(await (await app.fetch(stream())).text()).toBe("1234567890")
    expect(calls).toBe(2)
  })

  test("validates construction", () => {
    expect(() => idempotency({ store: new MemoryIdempotencyStore(), maxBytes: -1 })).toThrow(
      /maxBytes/,
    )
  })
})

describe("MemoryIdempotencyStore", () => {
  const ORIGINAL = process.env.NODE_ENV
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = ORIGINAL
  })

  test("new → in_flight → replay → released lifecycle", async () => {
    const store = new MemoryIdempotencyStore()
    const record = { status: 200, headers: [["content-type", "text/plain"]] as const, body: "" }

    expect(await store.begin("k", 60_000)).toEqual({ state: "new" })
    expect(await store.begin("k", 60_000)).toEqual({ state: "in_flight" }) // lock held
    await store.complete("k", record, 60_000)
    expect(await store.begin("k", 60_000)).toEqual({ state: "replay", record })

    await store.begin("k2", 60_000)
    await store.release("k2")
    expect(await store.begin("k2", 60_000)).toEqual({ state: "new" }) // released ⇒ free again
  })

  test("an expired lock frees the key (a crashed handler can't wedge it forever)", async () => {
    const store = new MemoryIdempotencyStore()
    expect(await store.begin("k", 20)).toEqual({ state: "new" })
    expect(await store.begin("k", 20)).toEqual({ state: "in_flight" })
    await Bun.sleep(40)
    expect(await store.begin("k", 20)).toEqual({ state: "new" }) // lock expired
  })

  test("refuses to construct in production unless explicitly allowed", () => {
    process.env.NODE_ENV = "production"
    expect(() => new MemoryIdempotencyStore()).toThrow(/per-instance/)
    expect(() => new MemoryIdempotencyStore({ allowInProduction: true })).not.toThrow()
  })
})

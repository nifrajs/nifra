import { describe, expect, test } from "bun:test"
import { NIFRA_ASSURANCE, withRouteAssurance } from "../src/assurance.ts"
import { evaluateCapabilityAssurance } from "../src/capabilities.ts"
import {
  canonicalizeIdempotencyBody,
  computeIdempotencyFingerprint,
  createMemoryIdempotencyStore,
  DEFAULT_IDEMPOTENCY_PENDING_TTL_MS,
  IDEMPOTENT_REPLAY_HEADER,
  type IdempotencyBeginInput,
  type IdempotencyStore,
  MemoryIdempotencyStore,
  responseFromStored,
  serializeResponse,
  validIdempotencyKey,
} from "../src/idempotency.ts"
import { idempotency, markIdempotencySafeToRetry } from "../src/idempotency-plugin.ts"
import { authenticated, rejected, server } from "../src/index.ts"
import {
  beginRequestEffectTracking,
  markBeaconEffectBegan,
  markEffectAmbiguous,
  markEffectCommitted,
  markEffectExecuting,
  requestEffectEvidence,
  requestEffectScope,
} from "../src/internal/effect-execution.ts"
import { createIdempotencyRuntime } from "../src/server/idempotency-lane.ts"

/** A POST whose length-less body is still producing when a cap trips: its last chunk is never
 * pulled. */
function overCapPost(url: string, headers: Record<string, string> = {}): Request {
  let sent = 0
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 2) return controller.close()
        controller.enqueue(new Uint8Array(65_536).fill(32))
      },
    }),
    duplex: "half",
  }
  return new Request(url, init)
}

/** Resolves with the response, or with "no response" once `ms` pass without one. */
function within(
  ms: number,
  response: Promise<Response> | Response,
): Promise<Response | "no response"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"no response">((resolve) => {
    timer = setTimeout(() => resolve("no response"), ms)
  })
  return Promise.race([Promise.resolve(response), deadline]).finally(() => clearTimeout(timer))
}

const post = (body: unknown, key?: string, extra?: Record<string, string>): Request =>
  new Request("http://test/pay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key !== undefined ? { "idempotency-key": key } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  })

const begin = (
  store: MemoryIdempotencyStore,
  key: string,
  fingerprint: string,
  ttlMs: number,
  namespace = "global",
) => store.begin({ namespace, key, fingerprint, ttlMs })

describe("MemoryIdempotencyStore", () => {
  test("first begin is new; a second with the same fingerprint is in-flight until completed", () => {
    const store = new MemoryIdempotencyStore()
    const first = begin(store, "k1", "fp", 1000)
    expect(first.state).toBe("new")
    expect(begin(store, "k1", "fp", 1000).state).toBe("in-flight")
    if (first.state !== "new") throw new Error("expected reservation")
    store.complete({
      namespace: "global",
      key: "k1",
      reservation: first.reservation,
      response: { status: 200, headers: [], body: "" },
    })
    const replay = begin(store, "k1", "fp", 1000)
    expect(replay.state).toBe("replay")
    if (replay.state === "replay") expect(replay.response.status).toBe(200)
  })

  test("same key, different fingerprint is a mismatch", () => {
    const store = new MemoryIdempotencyStore()
    begin(store, "k1", "fp-a", 1000)
    expect(begin(store, "k1", "fp-b", 1000).state).toBe("mismatch")
  })

  test("an expired entry is treated as absent (new again)", () => {
    let now = 1_000
    const store = new MemoryIdempotencyStore({ now: () => now })
    const first = begin(store, "k1", "fp", 100)
    if (first.state !== "new") throw new Error("expected reservation")
    store.complete({
      namespace: "global",
      key: "k1",
      reservation: first.reservation,
      response: { status: 200, headers: [], body: "" },
    })
    expect(begin(store, "k1", "fp", 100).state).toBe("replay")
    now = 1_101 // past the 100ms ttl
    expect(begin(store, "k1", "fp", 100).state).toBe("new")
  })

  test("abandon releases a pending reservation but never a completed one", () => {
    const store = new MemoryIdempotencyStore()
    const first = begin(store, "k1", "fp", 1000)
    if (first.state !== "new") throw new Error("expected reservation")
    store.abandon({ namespace: "global", key: "k1", reservation: first.reservation })
    const second = begin(store, "k1", "fp", 1000)
    expect(second.state).toBe("new") // released → fresh
    if (second.state !== "new") throw new Error("expected reservation")
    store.complete({
      namespace: "global",
      key: "k1",
      reservation: second.reservation,
      response: { status: 200, headers: [], body: "" },
    })
    store.abandon({ namespace: "global", key: "k1", reservation: second.reservation })
    expect(begin(store, "k1", "fp", 1000).state).toBe("replay") // completed → retained
  })

  test("sweep evicts expired entries", () => {
    let now = 0
    const store = new MemoryIdempotencyStore({ now: () => now })
    begin(store, "k1", "fp", 10)
    expect(store.size).toBe(1)
    now = 100
    store.sweep()
    expect(store.size).toBe(0)
  })

  test("createMemoryIdempotencyStore factory yields a working store", () => {
    const store = createMemoryIdempotencyStore()
    expect(begin(store, "k", "fp", 1000).state).toBe("new")
  })

  test("the same client key is isolated by namespace", () => {
    const store = new MemoryIdempotencyStore()
    expect(begin(store, "same", "fp-a", 1000, "tenant-a").state).toBe("new")
    expect(begin(store, "same", "fp-b", 1000, "tenant-b").state).toBe("new")
  })

  test("a stale reservation cannot complete or abandon a newer owner", () => {
    let now = 0
    const store = new MemoryIdempotencyStore({ now: () => now })
    const old = begin(store, "k", "fp", 10)
    if (old.state !== "new") throw new Error("expected reservation")
    now = 11
    const current = begin(store, "k", "fp", 10)
    if (current.state !== "new") throw new Error("expected replacement reservation")
    expect(
      store.complete({
        namespace: "global",
        key: "k",
        reservation: old.reservation,
        response: { status: 200, headers: [], body: "old" },
      }),
    ).toBe(false)
    expect(store.abandon({ namespace: "global", key: "k", reservation: old.reservation })).toBe(
      false,
    )
    expect(begin(store, "k", "fp", 10).state).toBe("in-flight")
  })

  test("an expired owner cannot complete or abandon before another caller re-reserves", () => {
    let now = 0
    const store = new MemoryIdempotencyStore({ now: () => now })
    const expired = begin(store, "k", "fp", 10)
    if (expired.state !== "new") throw new Error("expected reservation")
    now = 11
    expect(
      store.complete({
        namespace: "global",
        key: "k",
        reservation: expired.reservation,
        response: { status: 200, headers: [], body: "" },
      }),
    ).toBe(false)
    expect(store.abandon({ namespace: "global", key: "k", reservation: expired.reservation })).toBe(
      false,
    )
    expect(store.size).toBe(0)
  })

  test("capacity fails closed instead of evicting a live replay/pending reservation", () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 1 })
    expect(begin(store, "a", "fp", 1000).state).toBe("new")
    expect(begin(store, "b", "fp", 1000).state).toBe("capacity")
  })

  test("a namespace bound keeps one namespace from using up the store", () => {
    let now = 0
    const store = new MemoryIdempotencyStore({
      maxEntries: 10,
      maxEntriesPerNamespace: 2,
      now: () => now,
    })
    const first = begin(store, "1", "fp", 1000, "tenant-a")
    expect(begin(store, "2", "fp", 1000, "tenant-a").state).toBe("new")
    expect(begin(store, "3", "fp", 1000, "tenant-a").state).toBe("capacity")
    expect(begin(store, "1", "fp", 1000, "tenant-b").state).toBe("new")
    if (first.state !== "new") throw new Error("expected a reservation")
    expect(store.abandon({ namespace: "tenant-a", key: "1", reservation: first.reservation })).toBe(
      true,
    )
    expect(begin(store, "3", "fp", 1000, "tenant-a").state).toBe("new")
    expect(begin(store, "4", "fp", 1000, "tenant-a").state).toBe("capacity")
    now = 1000
    expect(begin(store, "4", "fp", 1000, "tenant-a").state).toBe("new")
    expect(() => new MemoryIdempotencyStore({ maxEntriesPerNamespace: 0 })).toThrow(
      /maxEntriesPerNamespace/,
    )
  })

  test("a pending reservation lapses after its lease unless renewed, and completes for ttlMs", () => {
    let now = 0
    const store = new MemoryIdempotencyStore({ now: () => now })
    const input = { namespace: "global", key: "k1", fingerprint: "fp", ttlMs: 1000 }
    const first = store.begin({ ...input, pendingTtlMs: 100 })
    if (first.state !== "new") throw new Error("expected a reservation")
    const owner = { namespace: "global", key: "k1", reservation: first.reservation }
    now = 80
    expect(store.renew({ ...owner, ttlMs: 100 })).toBe(true)
    now = 150
    expect(store.begin(input).state).toBe("in-flight")
    now = 181
    expect(store.renew({ ...owner, ttlMs: 100 })).toBe(false)
    const second = store.begin({ ...input, pendingTtlMs: 100 })
    if (second.state !== "new") throw new Error("expected the lapsed key to be reserved again")
    const response = { status: 200, headers: [], body: "" }
    expect(store.complete({ ...owner, response })).toBe(false)
    expect(
      store.complete({ namespace: "global", key: "k1", reservation: second.reservation, response }),
    ).toBe(true)
    expect(store.renew({ ...owner, reservation: second.reservation, ttlMs: 100 })).toBe(false)
    now = 1100
    expect(store.begin(input).state).toBe("replay")
  })
})

describe("effect-aware idempotency fallback", () => {
  const configFor = (store: MemoryIdempotencyStore) => {
    const runtime = createIdempotencyRuntime({ store })
    const config = runtime.resolve(
      { idempotency: { scope: "request", namespace: "test" } },
      false,
      1024,
    )
    if (config === undefined) throw new Error("expected config")
    return { runtime, config }
  }

  test("an escaped pre-effect failure releases its reservation", async () => {
    const store = new MemoryIdempotencyStore()
    const { runtime, config } = configFor(store)
    let runs = 0
    const run = () =>
      runtime.run(
        config,
        post({ amount: 1 }, "pre-effect"),
        undefined,
        {},
        {},
        undefined,
        (r) => r,
        {
          maxBodyBytes: 1024,
          async runLanes() {
            runs++
            if (runs === 1) throw new Error("framework failure")
            return new Response(null, { status: 204 })
          },
        },
      )
    await expect(run()).rejects.toThrow("framework failure")
    expect((await run()).status).toBe(204)
    expect(runs).toBe(2)
  })

  test("an escaped ambiguous effect is terminal and replayed", async () => {
    const store = new MemoryIdempotencyStore()
    const { runtime, config } = configFor(store)
    let runs = 0
    const run = () =>
      runtime.run(
        config,
        post({ amount: 1 }, "ambiguous"),
        undefined,
        {},
        {},
        undefined,
        (r) => r,
        {
          maxBodyBytes: 1024,
          async runLanes(request) {
            runs++
            markBeaconEffectBegan({ req: request })
            throw new Error("connection dropped after send")
          },
        },
      )
    expect((await run()).status).toBe(500)
    const replay = await run()
    expect(replay.status).toBe(500)
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("1")
    expect(runs).toBe(1)
  })

  test("request-local evidence distinguishes executing, committed, and ambiguous states", () => {
    const request = new Request("http://test/effect")
    const context = { req: request }
    beginRequestEffectTracking(request)
    expect(requestEffectScope(request)).toBeDefined()
    markEffectExecuting(context)
    expect(requestEffectEvidence(request)).toEqual({
      began: true,
      committed: false,
      ambiguous: true,
    })
    markEffectCommitted(context)
    expect(requestEffectEvidence(request)).toEqual({
      began: true,
      committed: true,
      ambiguous: false,
    })
    markEffectAmbiguous(context)
    expect(requestEffectEvidence(request)).toEqual({
      began: true,
      committed: true,
      ambiguous: true,
    })
    expect(() =>
      markIdempotencySafeToRetry({ req: new Request("http://test/not-idempotent") }),
    ).toThrow("requires an active route")
  })
})

describe("idempotency primitives", () => {
  test("validIdempotencyKey rejects empty, oversized, and control-char keys", () => {
    expect(validIdempotencyKey("abc-123")).toBe(true)
    expect(validIdempotencyKey("")).toBe(false)
    expect(validIdempotencyKey("x".repeat(256))).toBe(false)
    expect(validIdempotencyKey("bad\nkey")).toBe(false)
  })

  test("fingerprint is deterministic and body-sensitive", async () => {
    const a = await computeIdempotencyFingerprint("POST", "/pay", new TextEncoder().encode("{}"))
    const b = await computeIdempotencyFingerprint("POST", "/pay", new TextEncoder().encode("{}"))
    const c = await computeIdempotencyFingerprint("POST", "/pay", new TextEncoder().encode("{ }"))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test("JSON canonicalization ignores whitespace and object property order", async () => {
    const a = canonicalizeIdempotencyBody(
      new TextEncoder().encode('{"amount":10,"currency":"INR"}'),
      "application/json",
    )
    const b = canonicalizeIdempotencyBody(
      new TextEncoder().encode('{ "currency": "INR", "amount": 10 }'),
      "application/json; charset=utf-8",
    )
    expect(new TextDecoder().decode(a)).toBe(new TextDecoder().decode(b))
  })

  test("serialize/replay round-trips status, headers, and a binary body + stamps the replay header", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254])
    const original = new Response(bytes, { status: 201, headers: { "x-test": "v" } })
    const stored = await serializeResponse(original)
    expect(await original.arrayBuffer()).toBeDefined() // original body still readable (clone was used)
    const replayed = responseFromStored(stored)
    expect(replayed.status).toBe(201)
    expect(replayed.headers.get("x-test")).toBe("v")
    expect(replayed.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("1")
    expect(new Uint8Array(await replayed.arrayBuffer())).toEqual(bytes)
  })

  test("oversized streamed serialization cancels both tee branches promptly", async () => {
    const encoder = new TextEncoder()
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("1234"))
        },
      }),
    )
    await expect(
      Promise.race([
        serializeResponse(original, { maxBytes: 1 }),
        Bun.sleep(250).then(() => {
          throw new Error("serialization timed out")
        }),
      ]),
    ).rejects.toThrow(/response exceeds/i)
  })

  test("replay enforces the configured response bound before decoding store data", () => {
    expect(() =>
      responseFromStored({ status: 200, headers: [], body: "AQID" }, { maxBytes: 2 }),
    ).toThrow(/response exceeds/i)
  })

  test("legacy stored records cannot replay session or hop-by-hop headers", () => {
    const replayed = responseFromStored({
      status: 200,
      headers: [
        ["set-cookie", "sid=legacy-secret"],
        ["connection", "keep-alive"],
        ["transfer-encoding", "chunked"],
        ["x-safe", "kept"],
      ],
      body: "",
    })

    expect(replayed.headers.get("set-cookie")).toBeNull()
    expect(replayed.headers.get("connection")).toBeNull()
    expect(replayed.headers.get("transfer-encoding")).toBeNull()
    expect(replayed.headers.get("x-safe")).toBe("kept")
  })
})

describe("server({ idempotency }) - request path", () => {
  test("durable scope rejects an in-memory store at registration", () => {
    expect(() =>
      server()
        .use(idempotency())
        .post(
          "/pay",
          {
            idempotency: {
              scope: "durable",
              namespace: "public:pay",
              store: new MemoryIdempotencyStore(),
            },
          },
          () => ({ ok: true }),
        ),
    ).toThrow(/durable idempotency requires a durable store/i)
  })

  test("replays the stored response on a repeated key without re-running the handler", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, () => {
        runs += 1
        return { charged: true, run: runs }
      })
    const first = await app.fetch(post({ amount: 10 }, "key-1"))
    const second = await app.fetch(post({ amount: 10 }, "key-1"))
    expect(runs).toBe(1) // handler ran once
    expect(await first.json()).toEqual({ charged: true, run: 1 })
    expect(await second.json()).toEqual({ charged: true, run: 1 }) // identical replay
    expect(first.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeNull()
    expect(second.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("1")
  })

  test("never replays a session cookie from a successful response", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post(
        "/session",
        { idempotency: { scope: "request", namespace: "principal:user-1" } },
        () =>
          new Response(JSON.stringify({ run: ++runs }), {
            headers: {
              "content-type": "application/json",
              "set-cookie": "sid=secret-session; Path=/; HttpOnly; Secure",
            },
          }),
      )
    const request = () =>
      new Request("http://x/session", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "session-key" },
        body: JSON.stringify({ login: true }),
      })

    const first = await app.fetch(request())
    const replay = await app.fetch(request())

    expect(first.headers.get("set-cookie")).toContain("sid=secret-session")
    expect(replay.headers.get("set-cookie")).toBeNull()
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("1")
    expect(await replay.json()).toEqual({ run: 1 })
    expect(runs).toBe(1)
  })

  test("a missing key on an idempotency-required route fails closed with 400", async () => {
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, () => ({
        ok: true,
      }))
    const res = await app.fetch(post({ amount: 1 }))
    expect(res.status).toBe(400)
  })

  test("reusing a key with a different body is rejected 409", async () => {
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, () => ({
        ok: true,
      }))
    expect((await app.fetch(post({ amount: 1 }, "k"))).status).toBe(200)
    const reused = await app.fetch(post({ amount: 999 }, "k"))
    expect(reused.status).toBe(409)
  })

  test("a concurrent duplicate (still in flight) is rejected 409 with Retry-After", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, async () => {
        await gate
        return { ok: true }
      })
    const first = app.fetch(post({ amount: 1 }, "dup"))
    await new Promise((r) => setTimeout(r, 0))
    const second = await app.fetch(post({ amount: 1 }, "dup")) // key reserved, not completed
    expect(second.status).toBe(409)
    expect(second.headers.get("retry-after")).toBe("1")
    release()
    expect((await first).status).toBe(200)
  })

  test("an error response is terminal so a retry cannot duplicate an already-finished effect", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, (c) => {
        runs += 1
        return c.json({ error: "boom" }, 500)
      })
    expect((await app.fetch(post({ amount: 1 }, "e"))).status).toBe(500)
    const replay = await app.fetch(post({ amount: 1 }, "e"))
    expect(replay.status).toBe(500)
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("1")
    expect(runs).toBe(1)
  })

  test("a handler's refusal with no owned effect releases its key", async () => {
    const store = new MemoryIdempotencyStore()
    let runs = 0
    const app = server()
      .use(idempotency({ store }))
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, (c) => {
        runs += 1
        if (c.req.headers.get("authorization") !== "Bearer good")
          return c.json({ error: "unauthorized" }, 401)
        if (c.req.headers.get("x-hold") === "1") {
          markEffectExecuting(c)
          return c.json({ error: "conflict" }, 409)
        }
        return { paid: true }
      })
    for (let i = 0; i < 3; i++)
      expect((await app.fetch(post({ amount: 1 }, `anonymous-${i}`))).status).toBe(401)
    expect(store.size).toBe(0)
    expect((await app.fetch(post({ amount: 1 }, "k"))).status).toBe(401)
    const paid = await app.fetch(post({ amount: 1 }, "k", { authorization: "Bearer good" }))
    expect(paid.status).toBe(200)
    expect(paid.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeNull()
    expect(store.size).toBe(1)
    // Once an owned effect began, even a refusal is the key's answer.
    const held = { authorization: "Bearer good", "x-hold": "1" }
    expect((await app.fetch(post({ amount: 2 }, "held", held))).status).toBe(409)
    const replay = await app.fetch(post({ amount: 2 }, "held", held))
    expect(replay.status).toBe(409)
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("1")
    expect(runs).toBe(6)
  })

  test("a response body that fails while being stored never leaves its key in progress", async () => {
    let runs = 0
    const broken = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("upstream broke"))
          },
        }),
      )
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, (c) => {
        runs += 1
        if (c.req.headers.get("x-effect") === "1") markEffectExecuting(c)
        return broken()
      })
    const outcome = (request: Request) =>
      Promise.resolve(app.fetch(request)).then(
        (response) => response.status,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
    // No owned effect began: the key is released, so the retry runs again.
    expect(await outcome(post({ amount: 1 }, "free"))).toBe("upstream broke")
    expect(await outcome(post({ amount: 1 }, "free"))).toBe("upstream broke")
    expect(runs).toBe(2)
    // An owned effect began: the key keeps a terminal 500 that the retry replays.
    expect(await outcome(post({ amount: 1 }, "owned", { "x-effect": "1" }))).toBe(500)
    const replay = await app.fetch(post({ amount: 1 }, "owned", { "x-effect": "1" }))
    expect(replay.status).toBe(500)
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("1")
    expect(runs).toBe(3)
  })

  test("an explicit no-effect outcome releases a resolved 5xx for a safe retry", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, (c) => {
        runs += 1
        if (runs === 1) {
          markIdempotencySafeToRetry(c)
          return c.json({ error: "dependency_unavailable" }, 503)
        }
        return { charged: true }
      })

    expect((await app.fetch(post({ amount: 1 }, "retry-safe"))).status).toBe(503)
    expect((await app.fetch(post({ amount: 1 }, "retry-safe"))).status).toBe(200)
    expect(runs).toBe(2)
  })

  test("a later effect invalidates an earlier safe-retry declaration", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, (c) => {
        runs += 1
        markIdempotencySafeToRetry(c)
        markEffectExecuting(c)
        return c.json({ error: "provider_outcome_unknown" }, 503)
      })

    expect((await app.fetch(post({ amount: 1 }, "retry-invalidated"))).status).toBe(503)
    const replay = await app.fetch(post({ amount: 1 }, "retry-invalidated"))
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("1")
    expect(runs).toBe(1)
  })

  test("honors a custom header name", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post(
        "/pay",
        {
          idempotency: {
            scope: "request",
            namespace: "public:pay",
            headerName: "X-Idem",
          },
        },
        () => {
          runs += 1
          return { ok: true }
        },
      )
    await app.fetch(post({ a: 1 }, undefined, { "x-idem": "ck" }))
    await app.fetch(post({ a: 1 }, undefined, { "x-idem": "ck" }))
    expect(runs).toBe(1)
  })

  test("a namespace resolver isolates identical keys for different tenants", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post(
        "/pay",
        {
          idempotency: {
            scope: "request",
            namespace: (request) => request.headers.get("x-tenant") ?? "missing",
          },
        },
        () => ({ run: ++runs }),
      )
    const request = (tenant: string) => post({ amount: 1 }, "same", { "x-tenant": tenant })
    expect(await (await app.fetch(request("a"))).json()).toEqual({ run: 1 })
    expect(await (await app.fetch(request("b"))).json()).toEqual({ run: 2 })
    expect(await (await app.fetch(request("a"))).json()).toEqual({ run: 1 })
  })

  test("a namespace resolver does not hold up the 413 for a length-less body over the cap", async () => {
    const app = server({ maxBodyBytes: 1024 })
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: () => "tenant:a" } }, () => ({
        ok: true,
      }))
    const response = await within(
      2000,
      app.fetch(
        overCapPost("http://test/pay", {
          "content-type": "application/json",
          "idempotency-key": "key-1",
        }),
      ),
    )
    expect(response === "no response" ? response : response.status).toBe(413)
  })

  test("a request rejected before its handler runs releases its key instead of storing it", async () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 2 })
    let runs = 0
    const named = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "object" && value !== null && "name" in value
            ? { value }
            : { issues: [{ message: "name is required" }] },
      },
    } as const
    const app = server()
      .authenticate({
        id: "bearer",
        mode: "sync",
        run: (input) =>
          input.headers.get("authorization") === "Bearer good"
            ? authenticated({ userId: "u1" })
            : rejected(),
      })
      .use(idempotency({ store }))
      .post(
        "/pay",
        {
          body: named,
          idempotency: {
            scope: "request",
            namespace: (request) =>
              request.headers.get("authorization") === "Bearer good"
                ? "principal:u1"
                : "principal:anonymous",
          },
        },
        () => ({ run: ++runs }),
      )
    const order = (key: string, body: unknown, authorization?: string) =>
      post(body, key, authorization === undefined ? {} : { authorization })
    for (let i = 0; i < 5; i++) {
      expect((await app.fetch(order(`anonymous-${i}`, { name: "x" }))).status).toBe(401)
    }
    expect((await app.fetch(order("bad-body", { nope: 1 }, "Bearer good"))).status).toBe(422)
    expect(store.size).toBe(0)
    const fresh = await app.fetch(order("bad-body", { name: "x" }, "Bearer good"))
    expect(fresh.status).toBe(200)
    expect(await fresh.json()).toEqual({ run: 1 })
    expect(store.size).toBe(1)
  })

  test("registration rejects invalid TTL/header configuration and idempotent SSE", () => {
    expect(() =>
      server()
        .use(idempotency())
        .post(
          "/unbounded",
          {
            bodyLimit: "unlimited",
            bodyLimitReason: "streaming integration",
            idempotency: { scope: "request", namespace: "public:unbounded" },
          },
          () => ({}),
        ),
    ).toThrow(/cannot be used with idempotency/)
    expect(() =>
      server()
        .use(idempotency())
        .post("/x", { idempotency: { scope: "request" } as never }, () => ({})),
    ).toThrow(/namespace.*required/i)
    expect(() =>
      server()
        .use(idempotency())
        .post(
          "/x",
          { idempotency: { scope: "request", namespace: "public:x", ttlMs: 0 } },
          () => ({}),
        ),
    ).toThrow(/ttlMs/)
    expect(() =>
      server()
        .use(idempotency())
        .post(
          "/x",
          {
            idempotency: {
              scope: "request",
              namespace: "public:x",
              ttlMs: Number.MAX_SAFE_INTEGER + 1,
            },
          },
          () => ({}),
        ),
    ).toThrow(/ttlMs/)
    expect(() =>
      server()
        .use(idempotency())
        .post(
          "/x",
          {
            idempotency: {
              scope: "request",
              namespace: "public:x",
              headerName: "bad header",
            },
          },
          () => ({}),
        ),
    ).toThrow(/header name/)
    expect(() =>
      server()
        .use(idempotency())
        .post("/x", { idempotency: { scope: "request", namespace: "not namespaced" } }, () => ({})),
    ).toThrow(/invalid idempotency namespace/i)
    expect(() =>
      server()
        .use(idempotency())
        .post(
          "/x",
          {
            idempotency: {
              scope: "request",
              namespace: "public:x",
              maxResponseBytes: 0,
            },
          },
          () => ({}),
        ),
    ).toThrow(/maxResponseBytes/i)
    expect(() =>
      server()
        .use(idempotency())
        .post(
          "/stream",
          {
            idempotency: { scope: "request", namespace: "public:stream" },
            sse: {} as never,
          },
          () => ({}),
        ),
    ).toThrow(/streaming/i)
  })

  test("an authenticated route requires a principal namespace resolver", () => {
    const authenticated = withRouteAssurance(
      { name: "test-auth", beforeHandle: () => undefined },
      {
        id: NIFRA_ASSURANCE.AUTHENTICATED,
        source: "test-auth",
        scope: "subsequent",
      },
    )

    expect(() =>
      server()
        .use(idempotency())
        .use(authenticated)
        .post("/account", { idempotency: { scope: "request", namespace: "shared" } }, () => ({
          ok: true,
        })),
    ).toThrow(/authenticated.*namespace resolver/i)

    expect(() =>
      server()
        .use(idempotency())
        .use(authenticated)
        .post(
          "/account",
          { idempotency: { scope: "request", namespace: () => "principal:user-1" } },
          () => ({ ok: true }),
        ),
    ).not.toThrow()
  })

  test("an oversized response is replaced and replayed without re-running the effect", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post(
        "/pay",
        {
          idempotency: {
            scope: "request",
            namespace: "public:pay",
            maxResponseBytes: 8,
          },
        },
        () => ({ value: "this is intentionally too large", run: ++runs }),
      )
    const first = await app.fetch(post({ amount: 1 }, "large"))
    const replay = await app.fetch(post({ amount: 1 }, "large"))
    expect(first.status).toBe(507)
    expect(replay.status).toBe(507)
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("1")
    expect(runs).toBe(1)
  })

  test("a key whose process stopped renewing frees after the pending lease, not the replay TTL", async () => {
    let now = 1_000_000
    const store = new MemoryIdempotencyStore({ now: () => now })
    let runs = 0
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const route = (block: boolean) =>
      server()
        .use(idempotency())
        .post(
          "/pay",
          { idempotency: { scope: "request", namespace: "public:pay", store } },
          async () => {
            runs++
            if (block) {
              entered()
              await gate
            }
            return { ok: true }
          },
        )
    // The first process reserves the key and never gets to renew it, as if it died mid-handler.
    const stalled = route(true).fetch(post({ amount: 1 }, "crash"))
    await started
    const survivor = route(false)
    expect((await survivor.fetch(post({ amount: 1 }, "crash"))).status).toBe(409)
    now += DEFAULT_IDEMPOTENCY_PENDING_TTL_MS + 1
    expect((await survivor.fetch(post({ amount: 1 }, "crash"))).status).toBe(200)
    expect(runs).toBe(2)
    release()
    const late = await stalled
    expect(late.status).toBe(503)
    expect(await late.json()).toMatchObject({ error: "idempotency_reservation_lost" })
  })

  test("the lease is renewed while the handler runs and stops once it settles", async () => {
    // The store's clock moves only when the test moves it, so a stalled event loop delays a
    // renewal without letting the lease lapse; the heartbeat itself still runs on real timers.
    let now = 1_000_000
    const memory = new MemoryIdempotencyStore({ now: () => now })
    const renewals: number[] = []
    let renewed = (): void => {}
    const store: IdempotencyStore = {
      begin: (input) => memory.begin(input),
      complete: (input) => memory.complete(input),
      abandon: (input) => memory.abandon(input),
      renew: (input) => {
        renewals.push(input.ttlMs)
        const kept = memory.renew(input)
        renewed()
        return kept
      },
    }
    let runs = 0
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = server()
      .use(idempotency())
      .post(
        "/pay",
        { idempotency: { scope: "request", namespace: "public:pay", store, pendingTtlMs: 300 } },
        async () => {
          runs++
          entered()
          await gate
          return { ok: true }
        },
      )
    const first = app.fetch(post({ amount: 1 }, "slow"))
    await started
    for (let step = 0; step < 2; step++) {
      now += 200
      await new Promise<void>((resolve) => {
        renewed = resolve
      })
    }
    // Past the 300ms lease: only the renewals keep a duplicate from running the handler again.
    expect((await app.fetch(post({ amount: 1 }, "slow"))).status).toBe(409)
    release()
    expect((await first).status).toBe(200)
    expect(runs).toBe(1)
    expect(renewals.length).toBeGreaterThanOrEqual(2)
    expect(new Set(renewals)).toEqual(new Set([300]))
    const settled = renewals.length
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(renewals.length).toBe(settled)
  })

  test("a renewal that fails lets the lease lapse, which completion reports", async () => {
    const memory = new MemoryIdempotencyStore()
    let attempts = 0
    const store: IdempotencyStore = {
      begin: (input) => memory.begin(input),
      complete: (input) => memory.complete(input),
      abandon: (input) => memory.abandon(input),
      renew: () => {
        attempts++
        throw new Error("store unreachable")
      },
    }
    const app = server()
      .use(idempotency())
      .post(
        "/pay",
        { idempotency: { scope: "request", namespace: "public:pay", store, pendingTtlMs: 30 } },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          return { ok: true }
        },
      )
    const res = await app.fetch(post({ amount: 1 }, "flaky"))
    expect(attempts).toBeGreaterThanOrEqual(1)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "idempotency_reservation_lost" })
  })

  test("a store without renew() holds a pending key for ttlMs, and pendingTtlMs on it is refused", async () => {
    const memory = new MemoryIdempotencyStore()
    const begun: IdempotencyBeginInput[] = []
    const store: IdempotencyStore = {
      begin: (input) => {
        begun.push(input)
        return memory.begin(input)
      },
      complete: (input) => memory.complete(input),
      abandon: (input) => memory.abandon(input),
    }
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay", store } }, () => ({
        ok: true,
      }))
    expect((await app.fetch(post({ amount: 1 }, "plain"))).status).toBe(200)
    expect(begun[0]?.pendingTtlMs).toBeUndefined()
    const declare = (pendingTtlMs: number, target: IdempotencyStore) => () =>
      server()
        .use(idempotency())
        .post(
          "/pay",
          {
            idempotency: { scope: "request", namespace: "public:pay", store: target, pendingTtlMs },
          },
          () => ({ ok: true }),
        )
    expect(declare(30_000, store)).toThrow(/pendingTtlMs .* on a store that implements renew\(\)/)
    expect(declare(0, memory)).toThrow(/pendingTtlMs must be a positive integer/)
    expect(declare(1.5, memory)).toThrow(/pendingTtlMs must be a positive integer/)
    expect(declare(30_000, memory)).not.toThrow()
  })

  test("an injected store receives the completed response", async () => {
    const store = new MemoryIdempotencyStore()
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay", store } }, () => ({
        ok: true,
      }))
    await app.fetch(post({ a: 1 }, "s1"))
    expect(store.size).toBe(1)
    const replay = begin(store, "s1", await fingerprintOf({ a: 1 }), 1000, "public:pay")
    expect(replay.state).toBe("replay")
  })
})

async function fingerprintOf(body: unknown): Promise<string> {
  return computeIdempotencyFingerprint(
    "POST",
    "/pay",
    new TextEncoder().encode(JSON.stringify(body)),
    "application/json",
  )
}

describe("idempotency ↔ capability assurance (F-loop closure)", () => {
  const writePolicy = {
    definitions: [{ id: "db.write", zone: "domain", access: "write", idempotency: "request" }],
    provenance: { imports: [], forbiddenImports: [] },
  } as const

  test("declaring idempotency clears the missing-request-idempotency finding for a write capability", () => {
    const withIdem = server()
      .use(idempotency())
      .post(
        "/pay",
        {
          capabilities: ["db.write"],
          idempotency: { scope: "request", namespace: "public:pay" },
        },
        () => ({ ok: true }),
      )
    const report = evaluateCapabilityAssurance(withIdem, writePolicy, {
      routes: [
        {
          method: "POST",
          path: "/pay",
          covered: true,
          evidence: [{ id: "db.write", kind: "static", source: "repo" }],
        },
      ],
    })
    expect(report.findings.some((f) => f.code === "missing-request-idempotency")).toBe(false)
  })

  test("without idempotency, the write capability still reports missing-request-idempotency", () => {
    const noIdem = server()
      .use(idempotency())
      .post("/pay", { capabilities: ["db.write"] }, () => ({ ok: true }))
    const report = evaluateCapabilityAssurance(noIdem, writePolicy, {
      routes: [
        {
          method: "POST",
          path: "/pay",
          covered: true,
          evidence: [{ id: "db.write", kind: "static", source: "repo" }],
        },
      ],
    })
    expect(report.findings.some((f) => f.code === "missing-request-idempotency")).toBe(true)
  })

  test("durable response replay does not falsely prove a durable command", () => {
    const durableStore = Object.assign(new MemoryIdempotencyStore(), {
      durability: "durable" as const,
    })
    const app = server()
      .use(idempotency())
      .post(
        "/charge",
        {
          capabilities: ["billing.charge"],
          idempotency: {
            scope: "durable",
            namespace: "public:charge",
            store: durableStore,
          },
        },
        () => ({ ok: true }),
      )
    const report = evaluateCapabilityAssurance(
      app,
      {
        definitions: [
          {
            id: "billing.charge",
            zone: "domain",
            access: "write",
            idempotency: "durable",
          },
        ],
        provenance: { imports: [], forbiddenImports: [] },
      },
      {
        routes: [
          {
            method: "POST",
            path: "/charge",
            covered: true,
            evidence: [{ id: "billing.charge", kind: "static", source: "billing" }],
          },
        ],
      },
    )
    expect(report.findings.some((finding) => finding.code === "missing-durable-idempotency")).toBe(
      true,
    )
  })
})

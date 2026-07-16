import { describe, expect, test } from "bun:test"
import { NIFRA_ASSURANCE, withRouteAssurance } from "../src/assurance.ts"
import { evaluateCapabilityAssurance } from "../src/capabilities.ts"
import {
  canonicalizeIdempotencyBody,
  computeIdempotencyFingerprint,
  createMemoryIdempotencyStore,
  IDEMPOTENT_REPLAY_HEADER,
  MemoryIdempotencyStore,
  responseFromStored,
  serializeResponse,
  validIdempotencyKey,
} from "../src/idempotency.ts"
import { idempotency } from "../src/idempotency-plugin.ts"
import { server } from "../src/index.ts"

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

describe("server({ idempotency }) — request path", () => {
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

  test("an error response is not cached — a retry re-runs the handler", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, (c) => {
        runs += 1
        return c.json({ error: "boom" }, 500)
      })
    expect((await app.fetch(post({ amount: 1 }, "e"))).status).toBe(500)
    expect((await app.fetch(post({ amount: 1 }, "e"))).status).toBe(500)
    expect(runs).toBe(2) // not replayed; the key was released
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

  test("registration rejects invalid TTL/header configuration and idempotent SSE", () => {
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

import { describe, expect, test } from "bun:test"
import {
  computeIdempotencyFingerprint,
  createMemoryIdempotencyStore,
  evaluateCapabilityAssurance,
  IDEMPOTENT_REPLAY_HEADER,
  MemoryIdempotencyStore,
  responseFromStored,
  serializeResponse,
  server,
  validIdempotencyKey,
} from "../src/index.ts"

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

describe("MemoryIdempotencyStore", () => {
  test("first begin is new; a second with the same fingerprint is in-flight until completed", () => {
    const store = new MemoryIdempotencyStore()
    expect(store.begin("k1", "fp", 1000).state).toBe("new")
    expect(store.begin("k1", "fp", 1000).state).toBe("in-flight")
    store.complete("k1", { status: 200, headers: [], body: "" })
    const replay = store.begin("k1", "fp", 1000)
    expect(replay.state).toBe("replay")
    if (replay.state === "replay") expect(replay.response.status).toBe(200)
  })

  test("same key, different fingerprint is a mismatch", () => {
    const store = new MemoryIdempotencyStore()
    store.begin("k1", "fp-a", 1000)
    expect(store.begin("k1", "fp-b", 1000).state).toBe("mismatch")
  })

  test("an expired entry is treated as absent (new again)", () => {
    let now = 1_000
    const store = new MemoryIdempotencyStore({ now: () => now })
    store.begin("k1", "fp", 100)
    store.complete("k1", { status: 200, headers: [], body: "" })
    expect(store.begin("k1", "fp", 100).state).toBe("replay")
    now = 1_101 // past the 100ms ttl
    expect(store.begin("k1", "fp", 100).state).toBe("new")
  })

  test("abandon releases a pending reservation but never a completed one", () => {
    const store = new MemoryIdempotencyStore()
    store.begin("k1", "fp", 1000)
    store.abandon("k1")
    expect(store.begin("k1", "fp", 1000).state).toBe("new") // released → fresh
    store.complete("k1", { status: 200, headers: [], body: "" })
    store.abandon("k1")
    expect(store.begin("k1", "fp", 1000).state).toBe("replay") // completed → retained
  })

  test("sweep evicts expired entries", () => {
    let now = 0
    const store = new MemoryIdempotencyStore({ now: () => now })
    store.begin("k1", "fp", 10)
    expect(store.size).toBe(1)
    now = 100
    store.sweep()
    expect(store.size).toBe(0)
  })

  test("createMemoryIdempotencyStore factory yields a working store", () => {
    const store = createMemoryIdempotencyStore()
    expect(store.begin("k", "fp", 1000).state).toBe("new")
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
})

describe("server({ idempotency }) — request path", () => {
  test("replays the stored response on a repeated key without re-running the handler", async () => {
    let runs = 0
    const app = server().post("/pay", { idempotency: { scope: "request" } }, () => {
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

  test("a missing key on an idempotency-required route fails closed with 400", async () => {
    const app = server().post("/pay", { idempotency: { scope: "request" } }, () => ({ ok: true }))
    const res = await app.fetch(post({ amount: 1 }))
    expect(res.status).toBe(400)
  })

  test("reusing a key with a different body is rejected 409", async () => {
    const app = server().post("/pay", { idempotency: { scope: "request" } }, () => ({ ok: true }))
    expect((await app.fetch(post({ amount: 1 }, "k"))).status).toBe(200)
    const reused = await app.fetch(post({ amount: 999 }, "k"))
    expect(reused.status).toBe(409)
  })

  test("a concurrent duplicate (still in flight) is rejected 409 with Retry-After", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const app = server().post("/pay", { idempotency: { scope: "request" } }, async () => {
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
    const app = server().post("/pay", { idempotency: { scope: "request" } }, (c) => {
      runs += 1
      return c.json({ error: "boom" }, 500)
    })
    expect((await app.fetch(post({ amount: 1 }, "e"))).status).toBe(500)
    expect((await app.fetch(post({ amount: 1 }, "e"))).status).toBe(500)
    expect(runs).toBe(2) // not replayed; the key was released
  })

  test("honors a custom header name", async () => {
    let runs = 0
    const app = server().post(
      "/pay",
      { idempotency: { scope: "request", headerName: "X-Idem" } },
      () => {
        runs += 1
        return { ok: true }
      },
    )
    await app.fetch(post({ a: 1 }, undefined, { "x-idem": "ck" }))
    await app.fetch(post({ a: 1 }, undefined, { "x-idem": "ck" }))
    expect(runs).toBe(1)
  })

  test("an injected store receives the completed response", async () => {
    const store = new MemoryIdempotencyStore()
    const app = server().post("/pay", { idempotency: { scope: "durable", store } }, () => ({
      ok: true,
    }))
    await app.fetch(post({ a: 1 }, "s1"))
    expect(store.size).toBe(1)
    const replay = store.begin("s1", await fingerprintOf({ a: 1 }), 1000)
    expect(replay.state).toBe("replay")
  })
})

async function fingerprintOf(body: unknown): Promise<string> {
  return computeIdempotencyFingerprint(
    "POST",
    "/pay",
    new TextEncoder().encode(JSON.stringify(body)),
  )
}

describe("idempotency ↔ capability assurance (F-loop closure)", () => {
  const writePolicy = {
    definitions: [{ id: "db.write", zone: "domain", access: "write", idempotency: "request" }],
    provenance: { imports: [], forbiddenImports: [] },
  } as const

  test("declaring idempotency clears the missing-request-idempotency finding for a write capability", () => {
    const withIdem = server().post(
      "/pay",
      { capabilities: ["db.write"], idempotency: { scope: "request" } },
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
    const noIdem = server().post("/pay", { capabilities: ["db.write"] }, () => ({ ok: true }))
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
})

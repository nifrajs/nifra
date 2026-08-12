import { describe, expect, test } from "bun:test"
import { server, toFetchHandler } from "../src/index.ts"
import {
  applyTransportCap,
  hasTrustedBodyFraming,
  markTransportCap,
  markTrustedBodyFraming,
  parseContentLength,
  RAW_BODY_READERS,
  readBoundedBytes,
} from "../src/server/body.ts"

/**
 * `parseContentLength` is the integer guard at the front of the body-size cap (it replaced a
 * `/^\d+$/.test()` + `Number()` pair for speed). It is SECURITY-CRITICAL: a `Content-Length` that
 * parses too small lets an oversized body through the fast path, and one that's wrongly rejected
 * breaks valid requests. These tests pin: only `1*DIGIT` is accepted, everything else is `undefined`
 * (→ 400), an over-`MAX_SAFE_INTEGER` length saturates to `Infinity` (→ over any cap → 413), and the
 * result matches the legacy regex+`Number` behavior across the normal integer range.
 */
describe("parseContentLength - body-cap integer guard", () => {
  test("accepts bare digit strings (incl. leading zeros - HTTP grammar is 1*DIGIT)", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["0", 0],
      ["1", 1],
      ["42", 42],
      ["123", 123],
      ["007", 7],
      ["00", 0],
      ["1000000", 1_000_000],
    ]
    for (const [input, expected] of cases) {
      expect(parseContentLength(input)).toBe(expected)
    }
  })

  test("rejects everything that isn't all-digits → undefined (caller maps to 400)", () => {
    const malformed = [
      "", // an empty Content-Length is malformed, not zero
      " ",
      " 12", // leading space
      "12 ", // trailing space
      "1 2", // embedded space
      "12a",
      "a12",
      "-5", // negative
      "+5", // signed
      "1.5", // fractional
      "1e3", // exponential - Number() would accept this; we must NOT
      "0x10", // hex - Number() would accept this; we must NOT
      "0b1",
      "1,000",
      "Infinity",
      "NaN",
    ]
    for (const input of malformed) {
      expect(parseContentLength(input)).toBeUndefined()
    }
  })

  test("a length beyond MAX_SAFE_INTEGER saturates to Infinity (still > any cap → 413)", () => {
    expect(parseContentLength("99999999999999999999")).toBe(Number.POSITIVE_INFINITY)
    // Exactly MAX_SAFE_INTEGER stays finite (and is still far over any real body cap).
    expect(parseContentLength(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("agrees with the legacy /^\\d+$/ + Number() guard across the normal range", () => {
    const legacy = (s: string): number | undefined => (/^\d+$/.test(s) ? Number(s) : undefined)
    const inputs = ["0", "42", "007", "1000000", "", " 1", "1 ", "1e3", "0x10", "-1", "1.0", "abc"]
    for (const s of inputs) {
      const expected = legacy(s)
      const got = parseContentLength(s)
      if (expected === undefined) {
        expect(got).toBeUndefined()
      } else if (Number.isSafeInteger(expected)) {
        // Both reduce to the same integer; over-MAX values both end up > cap → 413, so only the
        // safe-integer range is compared exactly.
        expect(got).toBe(expected)
      }
    }
  })
})

/**
 * The fast path trusts `Content-Length` only as a fast-reject hint; the real byte count is checked
 * after the read. A "lying source" here models a buffering adapter that decodes or expands the body
 * upstream (the Hono GHSA-rv63-4mwf-qqc2 class: base64 decoded after the length was checked), so
 * the cap must hold on what was actually delivered, never on what was declared. Wire matrix - one
 * source shape, every framing case; adapters get no per-binding assertions of their own.
 */
describe("readBoundedBytes - the cap holds on real bytes (GHSA-rv63-4mwf-qqc2 class)", () => {
  /** A BodySource whose header claims `declared` but whose buffer holds `real` bytes. */
  const lyingSource = (declared: string | null, real: Uint8Array, chunked = false) => {
    let buffered = false
    const source = {
      headers: {
        get: (name: string) =>
          name === "content-length"
            ? declared
            : name === "transfer-encoding" && chunked
              ? "chunked"
              : null,
      },
      body: new Response(real.slice()).body,
      arrayBuffer: () => {
        buffered = true
        return Promise.resolve(real.slice().buffer as ArrayBuffer)
      },
    }
    return { source, wasBuffered: () => buffered }
  }
  const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(65)
  const CAP = 1000

  test("honest length within the cap passes with the bytes intact", async () => {
    const { source } = lyingSource("8", bytes(8))
    const r = await readBoundedBytes(source, CAP)
    expect(r).toEqual({ ok: true, bytes: bytes(8) })
  })

  test("uses an exact-byte reader when the source provides one", async () => {
    let arrayBufferCalled = false
    const real = bytes(8)
    const source = {
      headers: { get: (name: string) => (name === "content-length" ? "8" : null) },
      body: null,
      bytes: () => Promise.resolve(real),
      arrayBuffer: () => {
        arrayBufferCalled = true
        return Promise.reject(new Error("arrayBuffer should not be used"))
      },
    }
    expect(await readBoundedBytes(source, CAP)).toEqual({ ok: true, bytes: real })
    expect(arrayBufferCalled).toBe(false)
  })

  test("exact-cap boundary is allowed; one byte past the declaration is not", async () => {
    const atCap = await readBoundedBytes(lyingSource(String(CAP), bytes(CAP)).source, CAP)
    expect(atCap.ok).toBe(true)
    const oneOver = await readBoundedBytes(lyingSource(String(CAP), bytes(CAP + 1)).source, CAP)
    expect(oneOver).toEqual({ ok: false, status: 413 })
  })

  test("understated length: real bytes over the cap are rejected post-read", async () => {
    const { source } = lyingSource("5", bytes(3000))
    expect(await readBoundedBytes(source, CAP)).toEqual({ ok: false, status: 413 })
  })

  test("understated length: even under the cap, delivering more than declared is rejected", async () => {
    const { source } = lyingSource("5", bytes(800))
    expect(await readBoundedBytes(source, CAP)).toEqual({ ok: false, status: 413 })
  })

  test("overstated length is rejected before any buffering happens", async () => {
    const { source, wasBuffered } = lyingSource("3000", bytes(3000))
    expect(await readBoundedBytes(source, CAP)).toEqual({ ok: false, status: 413 })
    expect(wasBuffered()).toBe(false)
  })

  test("malformed length is 400, not a fall-through to the streaming guard", async () => {
    const { source, wasBuffered } = lyingSource("5; drop", bytes(5))
    expect(await readBoundedBytes(source, CAP)).toEqual({ ok: false, status: 400 })
    expect(wasBuffered()).toBe(false)
  })

  test("chunked bodies skip the fast path and the streaming guard counts real bytes", async () => {
    const { source, wasBuffered } = lyingSource("5", bytes(3000), true)
    expect(await readBoundedBytes(source, CAP)).toEqual({ ok: false, status: 413 })
    expect(wasBuffered()).toBe(false) // enforced by drainCapped, never by arrayBuffer framing
  })

  test("no length + no body reads as zero bytes", async () => {
    const source = {
      headers: { get: () => null },
      body: null,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    }
    expect(await readBoundedBytes(source, CAP)).toEqual({ ok: true, bytes: new Uint8Array(0) })
  })
})

describe("JSON schema lane - the cap holds on real bytes", () => {
  test("an understated Content-Length cannot bypass the JSON body cap", async () => {
    const app = server({ maxBodyBytes: 1000 }).post(
      "/users",
      {
        body: {
          "~standard": {
            version: 1,
            vendor: "test",
            validate(value: unknown) {
              return { value }
            },
          },
        },
      },
      () => ({ ok: true }),
    )
    const payload = JSON.stringify({ pad: "x".repeat(5000) })
    const response = await app.fetch(
      new Request("http://localhost/users", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "5",
        },
        body: payload,
      }),
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ ok: false, error: "payload_too_large" })
  })

  test("transport-capped requests retain the runtime byte reader for the JSON lane", async () => {
    const payload = JSON.stringify({ name: "Ada" })
    const request = new Request("http://localhost/users", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(payload).byteLength),
      },
      body: payload,
    })
    markTransportCap(request, 1_000)
    applyTransportCap(request, request)
    const raw = (request as unknown as { [RAW_BODY_READERS]?: { bytes?: unknown } })[
      RAW_BODY_READERS
    ]
    expect(typeof raw?.bytes).toBe("function")
  })
})

/**
 * The delivered-byte check exists for a source that can lie: an adapter rebuilding a body from an
 * event envelope, or a hand-built `Request`. A runtime that parsed the wire itself cannot, so its
 * ingress is marked and keeps the fused native parse. `Deno.serve` sets the mark WITHOUT importing
 * core (that adapter mirrors core's types on purpose), which is why the key is a registered symbol -
 * pin it here so a refactor to a unique symbol fails loudly instead of silently costing Deno a
 * whole extra pass over every JSON body.
 */
describe("trusted body framing", () => {
  const anyBody = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value: unknown) {
        return { value }
      },
    },
  } as never

  const understated = (payload: string) =>
    new Request("http://localhost/users", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "5" },
      body: payload,
    })

  test("the ingress mark is the registered symbol adapters set", () => {
    const request = new Request("http://localhost/users")
    markTrustedBodyFraming(request)
    expect(
      (request as unknown as Record<symbol, unknown>)[Symbol.for("nifra.body.trustedFraming")],
    ).toBe(true)
    expect(hasTrustedBodyFraming(new Request("http://localhost/users"))).toBe(false)
  })

  test("a marked request keeps the declared length as its frame", async () => {
    const app = server({ maxBodyBytes: 1000 }).post("/users", { body: anyBody }, (c) => c.body)
    const request = understated(JSON.stringify({ name: "Ada" }))
    markTrustedBodyFraming(request)
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "Ada" })
  })

  test("a marked request still walks the poisoning guard", async () => {
    const app = server({ maxBodyBytes: 1000 }).post("/users", { body: anyBody }, (c) => c.body)
    const request = understated('{"a":1,"__proto__":{"polluted":true}}')
    markTrustedBodyFraming(request)
    const response = await app.fetch(request)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: "invalid_json" })
  })

  test("toFetchHandler marks its ingress, so Workers/edge needs no opt-in", async () => {
    // `fetch(request, env, ctx)` is only ever called by the platform, so its request is runtime-framed
    // by construction - the edge adapter marks it and the app pays nothing, no server option needed.
    const app = server({ maxBodyBytes: 1000 }).post("/users", { body: anyBody }, (c) => c.body)
    const response = await toFetchHandler(app).fetch(
      understated(JSON.stringify({ name: "Ada" })),
      {},
      { waitUntil() {} },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "Ada" })
  })

  test("trustBodyFraming marks every app.fetch request (the edge opt-in)", async () => {
    const app = server({ maxBodyBytes: 1000, trustBodyFraming: true }).post(
      "/users",
      { body: anyBody },
      (c) => c.body,
    )
    const response = await app.fetch(understated(JSON.stringify({ name: "Ada" })))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "Ada" })
  })

  test("without the opt-in an oversized body is still rejected on its real bytes", async () => {
    const app = server({ maxBodyBytes: 1000, trustBodyFraming: true }).post(
      "/users",
      { body: anyBody },
      (c) => c.body,
    )
    // The mark trusts the FRAME, never the cap: a declared length over the limit is still 413, and
    // the streamed lane (no Content-Length at all) is untouched by the mark.
    const response = await app.fetch(
      new Request("http://localhost/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(5000) }),
      }),
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ ok: false, error: "payload_too_large" })
  })
})

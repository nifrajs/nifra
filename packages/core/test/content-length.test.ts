import { describe, expect, test } from "bun:test"
import { parseContentLength, readBoundedBytes } from "../src/server/body.ts"

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

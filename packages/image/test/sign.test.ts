import { describe, expect, test } from "bun:test"
import { hmacSha256Hex, signImageParams, verifyImageParams } from "../src/sign.ts"

describe("hmacSha256Hex — known-answer tests", () => {
  // Classic vector (exercises a short key + multi-block message).
  test("HMAC-SHA256('key', 'The quick brown fox…')", () => {
    expect(hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    )
  })
  // RFC 4231 Test Case 2.
  test("HMAC-SHA256('Jefe', 'what do ya want for nothing?')", () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    )
  })
  // A key longer than the 64-byte block is hashed first (RFC 2104) — exercises that branch.
  test("hashes an over-long key (deterministic, non-empty)", () => {
    const sig = hmacSha256Hex("x".repeat(100), "hello")
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    expect(hmacSha256Hex("x".repeat(100), "hello")).toBe(sig) // stable
  })
})

describe("signImageParams / verifyImageParams", () => {
  const secret = "s3cret-key_padded_to_at_least_32"
  const now = 1_000_000

  test("round-trips a valid signature", () => {
    const sig = signImageParams(secret, { src: "/a.jpg", w: "800", q: "75" })
    expect(verifyImageParams(secret, { src: "/a.jpg", w: "800", q: "75" }, sig, now)).toBe(true)
  })

  test("rejects a tampered src / width / quality", () => {
    const sig = signImageParams(secret, { src: "/a.jpg", w: "800", q: "75" })
    expect(verifyImageParams(secret, { src: "/evil.jpg", w: "800", q: "75" }, sig, now)).toBe(false)
    expect(verifyImageParams(secret, { src: "/a.jpg", w: "1600", q: "75" }, sig, now)).toBe(false)
    expect(verifyImageParams(secret, { src: "/a.jpg", w: "800", q: "100" }, sig, now)).toBe(false)
  })

  test("rejects a different secret and a malformed signature", () => {
    const sig = signImageParams(secret, { src: "/a.jpg", w: "800" })
    expect(
      verifyImageParams("other_secret_padded_to_at_least_3", { src: "/a.jpg", w: "800" }, sig, now),
    ).toBe(false)
    expect(verifyImageParams(secret, { src: "/a.jpg", w: "800" }, "short", now)).toBe(false)
  })

  test("distinguishes omitted vs present quality", () => {
    const noQ = signImageParams(secret, { src: "/a.jpg", w: "800" })
    expect(verifyImageParams(secret, { src: "/a.jpg", w: "800", q: "75" }, noQ, now)).toBe(false)
    expect(verifyImageParams(secret, { src: "/a.jpg", w: "800" }, noQ, now)).toBe(true)
  })

  test("honors expiry: valid before exp, rejected after, rejects non-numeric", () => {
    const parts = { src: "/a.jpg", w: "800", exp: String(now + 60) }
    const sig = signImageParams(secret, parts)
    expect(verifyImageParams(secret, parts, sig, now)).toBe(true) // not yet expired
    expect(verifyImageParams(secret, parts, sig, now + 120)).toBe(false) // expired
    expect(verifyImageParams(secret, { ...parts, exp: "abc" }, sig, now)).toBe(false) // malformed exp
  })
})

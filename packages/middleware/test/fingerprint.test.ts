import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { fingerprintFor, fnv1a, weakFingerprint } from "../src/_fingerprint.ts"

describe("weak fingerprints", () => {
  test("FNV-1a preserves its ASCII byte fingerprints", () => {
    expect(fnv1a("a")).toBe("e40c292c")
    expect(fnv1a("hello")).toBe(fnv1a(new TextEncoder().encode("hello")))
    expect(fnv1a("hello")).not.toBe(fnv1a("hellp"))
  })

  test("portable fingerprints hash UTF-8, including paired and unpaired surrogates", () => {
    const encode = new TextEncoder()
    const values = [
      "",
      "é",
      "Ã©",
      "日本",
      "😀",
      "\u007f",
      "\u0080",
      "\u07ff",
      "\u0800",
      "\ud7ff",
      "\ue000",
      "\uffff",
      "\ud800",
      "\udfff",
      "\ud800A",
      "\udc00\ud800",
      "\ud800\ud800",
      "\udbff\udfff",
    ]
    let seed = 12345
    for (let i = 0; i < 200; i++) {
      let value = ""
      for (let j = 0; j < 16; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        value += String.fromCharCode(seed & 0xffff)
      }
      values.push(value)
    }
    for (const runtime of [{}, { Deno: {} }]) {
      const fingerprint = fingerprintFor(runtime)
      for (const value of values) {
        expect(fingerprint(value)).toBe(fnv1a(encode.encode(value)))
      }
      expect(fingerprint("Ã©")).not.toBe(fingerprint(encode.encode("é")))
    }
  })

  test("Bun.hash is taken first, and called on Bun", () => {
    const seen: unknown[] = []
    const Bun = {
      hash(this: unknown, body: string | Uint8Array) {
        seen.push(this, body)
        return 42n
      },
    }
    expect(fingerprintFor({ Bun, Deno: {} })("x")).toBe("42")
    expect(seen).toEqual([Bun, "x"])
  })

  test("node:crypto's one-shot SHA-1 is taken where it exists, but not on Deno", () => {
    const proc = { getBuiltinModule: (id: string) => (id === "node:crypto" ? { hash } : undefined) }
    function hash(algorithm: string, body: string | Uint8Array, encoding: string): string {
      return `${algorithm}:${String(body)}:${encoding}`
    }
    expect(fingerprintFor({ process: proc })("x")).toBe("sha1:x:base64url")
    expect(fingerprintFor({ process: proc, Deno: {} })).toBe(fnv1a)
    // The real one tags as SHA-1 does.
    expect(fingerprintFor({ process })("body")).toBe(
      createHash("sha1").update("body").digest("base64url"),
    )
  })

  test("FNV-1a stays wherever no native hash is reachable", () => {
    const refusing = {
      getBuiltinModule() {
        throw new Error("no builtins here")
      },
    }
    for (const runtime of [{}, { process: {} }, { process: refusing }, { Bun: { hash: 1 } }]) {
      expect(fingerprintFor(runtime)).toBe(fnv1a)
    }
  })

  test("this runtime's choice is made once", () => {
    expect(weakFingerprint()).toBe(weakFingerprint())
    expect(weakFingerprint()("x")).toBe(String(Bun.hash("x")))
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import {
  type KVNamespaceLike,
  KVSessionStore,
  MemorySessionStore,
  type SessionRecord,
} from "../src/index.ts"

const rec = (data: Record<string, unknown>, expiresAt = 60_000): SessionRecord => ({
  data,
  expiresAt,
})

describe("MemorySessionStore", () => {
  test("get/set/delete round-trip", async () => {
    const store = new MemorySessionStore()
    expect(await store.get("a")).toBeUndefined()
    await store.set("a", rec({ u: 1 }))
    expect((await store.get("a"))?.data).toEqual({ u: 1 })
    await store.delete("a")
    expect(await store.get("a")).toBeUndefined()
    await store.delete("missing") // no-op
  })

  test("bounded — oldest-inserted evicts past max; re-set refreshes recency", async () => {
    const store = new MemorySessionStore({ max: 2 })
    await store.set("1", rec({ n: 1 }))
    await store.set("2", rec({ n: 2 }))
    await store.set("1", rec({ n: 11 })) // touch 1 → 2 is now oldest
    await store.set("3", rec({ n: 3 })) // evicts 2
    expect((await store.get("1"))?.data).toEqual({ n: 11 })
    expect(await store.get("2")).toBeUndefined()
    expect((await store.get("3"))?.data).toEqual({ n: 3 })
  })

  describe("production guard", () => {
    const prev = process.env.NODE_ENV
    afterEach(() => {
      process.env.NODE_ENV = prev ?? "test"
    })

    test("throws under NODE_ENV=production unless explicitly allowed", () => {
      process.env.NODE_ENV = "production"
      expect(() => new MemorySessionStore()).toThrow(/per-instance and unsafe in production/)
      expect(() => new MemorySessionStore({ allowInProduction: true })).not.toThrow()
    })

    test("allowed outside production", () => {
      process.env.NODE_ENV = "test"
      expect(() => new MemorySessionStore()).not.toThrow()
    })
  })
})

// A faithful in-memory KV double — records puts so the expiration backstop can be asserted.
class FakeKV implements KVNamespaceLike {
  readonly store = new Map<string, string>()
  readonly puts: Array<{ key: string; value: string; expiration: number | undefined }> = []
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null)
  }
  put(key: string, value: string, options?: { readonly expiration?: number }): Promise<void> {
    this.puts.push({ key, value, expiration: options?.expiration })
    this.store.set(key, value)
    return Promise.resolve()
  }
  delete(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }
}

describe("KVSessionStore", () => {
  test("set/get round-trip; KV expiration set from expiresAt (absolute unix seconds)", async () => {
    const kv = new FakeKV()
    const store = new KVSessionStore(kv)
    await store.set("a", rec({ u: 7 }, 90_000)) // expiresAt 90_000ms → expiration 90s
    expect(kv.puts.at(-1)?.expiration).toBe(90)
    expect(await store.get("a")).toEqual({ data: { u: 7 }, expiresAt: 90_000 })
  })

  test("miss → undefined; delete drops the key", async () => {
    const kv = new FakeKV()
    const store = new KVSessionStore(kv)
    expect(await store.get("nope")).toBeUndefined()
    await store.set("a", rec({ u: 1 }))
    await store.delete("a")
    expect(kv.store.has("a")).toBe(false)
  })

  test("a corrupt or wrong-shape entry reads as a miss (trust boundary)", async () => {
    const kv = new FakeKV()
    const store = new KVSessionStore(kv)
    kv.store.set("corrupt", "}{ not json")
    expect(await store.get("corrupt")).toBeUndefined()
    kv.store.set("scalar", "42") // valid JSON, not an object
    expect(await store.get("scalar")).toBeUndefined()
    kv.store.set("null", "null")
    expect(await store.get("null")).toBeUndefined()
    kv.store.set("no-exp", JSON.stringify({ data: {}, expiresAt: "soon" })) // expiresAt not a number
    expect(await store.get("no-exp")).toBeUndefined()
    kv.store.set("inf-exp", '{"data":{},"expiresAt":1e999}') // parses to Infinity → not finite
    expect(await store.get("inf-exp")).toBeUndefined()
    kv.store.set("bad-data", JSON.stringify({ data: 5, expiresAt: 1 })) // data not an object
    expect(await store.get("bad-data")).toBeUndefined()
    kv.store.set("null-data", JSON.stringify({ data: null, expiresAt: 1 }))
    expect(await store.get("null-data")).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { heapGrowth, isReleased } from "@nifrajs/test-utils/leak"
import { type CachedResponse, cache, MemoryResponseCache } from "../src/index.ts"

function entry(body: Uint8Array): CachedResponse {
  const now = Date.now()
  return {
    status: 200,
    statusText: "OK",
    headers: [],
    body,
    storedAt: now,
    expiresAt: now + 60_000,
  }
}

describe("MemoryResponseCache releases bodies", () => {
  test("past maxEntries", async () => {
    const store = new MemoryResponseCache({ maxEntries: 2 })
    let n = 0
    const make = () => {
      const body = new Uint8Array(4096)
      store.set(`k${n++}`, entry(body))
      return new WeakRef(body)
    }
    expect(await isReleased(make, { samples: 12, minCollected: 8 })).toBe(true)
  })

  test("past maxTotalBytes", async () => {
    const store = new MemoryResponseCache({ maxTotalBytes: 8192 })
    let n = 0
    const make = () => {
      const body = new Uint8Array(4096)
      store.set(`k${n++}`, entry(body))
      return new WeakRef(body)
    }
    expect(await isReleased(make, { samples: 12, minCollected: 8 })).toBe(true)
  })

  test("after delete", async () => {
    const store = new MemoryResponseCache()
    let n = 0
    const make = () => {
      const body = new Uint8Array(4096)
      const key = `k${n++}`
      store.set(key, entry(body))
      store.delete(key)
      return new WeakRef(body)
    }
    expect(await isReleased(make)).toBe(true)
  })
})

describe("cache() middleware", () => {
  test("heap stays flat across more distinct URLs than the store holds", async () => {
    const store = new MemoryResponseCache({ maxEntries: 50 })
    const app = server()
      .use(cache({ store, ttlMs: 60_000 }))
      .get("/item/:id", () => "x".repeat(512))
    const result = await heapGrowth(async (i) => {
      const response = await app.fetch(new Request(`http://x/item/${i}`))
      await response.text()
    })
    expect(result.bytesPerIteration).toBeLessThan(64)
  })
})

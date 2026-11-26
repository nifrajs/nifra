import { describe, expect, test } from "bun:test"
import { heapGrowth, isReleased } from "@nifrajs/test-utils/leak"
import { type CachedResponse, MemoryCacheStore } from "../src/isr.ts"

const CAP_BYTES_PER_ITERATION = 96

const page = (body: string, tags: readonly string[] = []): CachedResponse => ({
  body,
  status: 200,
  headers: { "content-type": "text/html" },
  storedAt: 0,
  revalidate: 60_000,
  tags,
})

describe("MemoryCacheStore retention", () => {
  test("pages past max are released", async () => {
    const store = new MemoryCacheStore({ max: 4 })
    let n = 0
    const make = async () => {
      const entry = page("x".repeat(4096))
      await store.set(`/p${n++}`, entry)
      return new WeakRef(entry)
    }
    expect(await isReleased(make, { samples: 12, minCollected: 8 })).toBe(true)
  })

  test("pages past the byte budget are released", async () => {
    const store = new MemoryCacheStore({ maxTotalBytes: 16_384 })
    let n = 0
    const make = async () => {
      const entry = page("x".repeat(4096))
      await store.set(`/p${n++}`, entry)
      return new WeakRef(entry)
    }
    expect(await isReleased(make, { samples: 12, minCollected: 8 })).toBe(true)
  })

  test("a page is released after its tag is invalidated", async () => {
    const store = new MemoryCacheStore()
    const make = async () => {
      const entry = page("x".repeat(4096), ["products"])
      await store.set("/p", entry)
      await store.invalidateTag("products")
      return new WeakRef(entry)
    }
    expect(await isReleased(make)).toBe(true)
  })

  test("heap stays flat across ever-new paths and tags", async () => {
    const store = new MemoryCacheStore({ max: 64 })
    const result = await heapGrowth(async (i) => {
      await store.set(`/p${i}`, page("x".repeat(512), [`tag${i}`]))
      await store.get(`/p${i - 10}`)
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("heap stays flat when one tag is purged over and over", async () => {
    const store = new MemoryCacheStore({ max: 64 })
    const result = await heapGrowth(async (i) => {
      await store.set(`/p${i % 100}`, page("x".repeat(512), ["shared"]))
      if (i % 50 === 0) await store.invalidateTag("shared")
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })
})

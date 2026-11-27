import { describe, expect, test } from "bun:test"
import { heapGrowth, isReleased } from "@nifrajs/test-utils/leak"
import { createCache } from "../src/cache.ts"
import { MemoryCache } from "../src/memory-cache.ts"

type Cache = ReturnType<typeof createCache>
type DropEntry = (cache: Cache, key: string) => Promise<void>

/** A value big enough that a retained one is unmistakable, and weakly observable. */
function payload(): {
  readonly value: { readonly bytes: Uint8Array }
  readonly ref: WeakRef<object>
} {
  const value = { bytes: new Uint8Array(4096) }
  return { value, ref: new WeakRef(value) }
}

/** Store a payload, run `drop`, and return a ref to the stored value with no local left holding it. */
async function storedThenDropped(
  cache: Cache,
  key: string,
  drop: DropEntry,
  tags: readonly string[] = [],
): Promise<WeakRef<object>> {
  const { value, ref } = payload()
  await cache.set(key, value, { tags })
  await drop(cache, key)
  return ref
}

describe("cache entries are released", () => {
  const drops: ReadonlyArray<readonly [string, DropEntry]> = [
    ["delete", (c, key) => c.delete(key)],
    ["invalidateTag", (c) => c.invalidateTag("t")],
    ["clear", (c) => c.clear()],
    ["overwrite", (c, key) => c.set(key, "replacement")],
  ]
  for (const [name, drop] of drops) {
    test(`after ${name}`, async () => {
      const cache = createCache({ store: new MemoryCache() })
      let sample = 0
      const make = () => storedThenDropped(cache, `sample-${sample++}`, drop, ["t"])
      expect(await isReleased(make)).toBe(true)
    })
  }

  test("after TTL expiry on read", async () => {
    let now = 1_000
    const cache = createCache({ now: () => now, store: new MemoryCache({ now: () => now }) })
    let sample = 0
    const make = () =>
      storedThenDropped(cache, `sample-${sample++}`, async (c, key) => {
        now += 120_000
        expect(await c.get(key)).toBeUndefined()
      })
    expect(await isReleased(make)).toBe(true)
  })

  test("after LRU eviction", async () => {
    const cache = createCache({ store: new MemoryCache({ maxEntries: 2 }) })
    let sample = 0
    const make = () =>
      storedThenDropped(cache, `sample-${sample++}`, async (c, key) => {
        await c.set(`${key}:a`, 1)
        await c.set(`${key}:b`, 2)
        expect(await c.get(key)).toBeUndefined()
      })
    expect(await isReleased(make)).toBe(true)
  })

  test("a rejected loader leaves no single-flight entry holding its closure", async () => {
    const cache = createCache({ store: new MemoryCache(), onError: () => undefined })
    const make = async () => {
      const { value, ref } = payload()
      await cache
        .wrap("k", () => {
          void value
          throw new Error("load failed")
        })
        .catch(() => undefined)
      return ref
    }
    expect(await isReleased(make)).toBe(true)
  })
})

describe("bound views", () => {
  test("a request context is not held by the cache", async () => {
    const cache = createCache({ beacon: () => undefined })
    const make = async () => {
      const context = { body: new Uint8Array(4096) }
      await cache.for(context).wrap("k", () => 1)
      await cache.for(context).get("k")
      return new WeakRef(context)
    }
    expect(await isReleased(make)).toBe(true)
  })

  test("an observed view does not hold its context either", async () => {
    const cache = createCache({ observer: () => undefined })
    const make = async () => {
      const context = { body: new Uint8Array(4096) }
      await cache.for(context).set("k", 1)
      return new WeakRef(context)
    }
    expect(await isReleased(make)).toBe(true)
  })
})

describe("heap stays flat", () => {
  const CAP_BYTES_PER_ITERATION = 64

  test("wrap over a bounded store with a bounded key space", async () => {
    const cache = createCache({ store: new MemoryCache({ maxEntries: 50 }) })
    const result = await heapGrowth(async (i) => {
      await cache.wrap(`key:${i % 200}`, () => new Uint8Array(512))
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("tags set and dropped with their key leave no tag index behind", async () => {
    const cache = createCache({ store: new MemoryCache() })
    const result = await heapGrowth(async (i) => {
      await cache.set("k", i, { tags: [`tag:${i}`] })
      await cache.delete("k")
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("a store write that keeps overwriting one key", async () => {
    const cache = createCache({ store: new MemoryCache() })
    const result = await heapGrowth(async (i) => {
      await cache.set("k", new Uint8Array(512), { tags: ["shared"] })
      if (i % 100 === 0) await cache.invalidateTag("shared")
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  // JSC holds a value that settled through `(async () => v)().finally(...)` for far longer than 40 GCs
  // with no nifra code involved, so a loaded value is judged by heap growth, not by a WeakRef.
  test("wrap then delete of a loaded value", async () => {
    const cache = createCache({ store: new MemoryCache() })
    const result = await heapGrowth(async () => {
      await cache.wrap("k", () => new Uint8Array(4096))
      await cache.delete("k")
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("a per-request bound view", async () => {
    const cache = createCache({ beacon: () => undefined })
    const result = await heapGrowth(async () => {
      const context = { body: new Uint8Array(512) }
      await cache.for(context).wrap("k", () => 1)
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })
})

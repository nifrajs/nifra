import { describe, expect, mock, test } from "bun:test"
import { forceGc, heapGrowth, isReleased } from "../src/leak.ts"

test("forceGc uses the exposed collector and throws when no collector is available", () => {
  const bunGc = Bun.gc
  const exposedGc = Object.getOwnPropertyDescriptor(globalThis, "gc")
  const gc = mock(() => {})
  try {
    Reflect.set(Bun, "gc", undefined)
    Reflect.set(globalThis, "gc", gc)
    forceGc()
    expect(gc).toHaveBeenCalledWith(true)

    Reflect.set(globalThis, "gc", undefined)
    expect(forceGc).toThrow("leak checks need a forced GC")
  } finally {
    Bun.gc = bunGc
    if (exposedGc === undefined) Reflect.deleteProperty(globalThis, "gc")
    else Object.defineProperty(globalThis, "gc", exposedGc)
  }
})

// The checks are only worth having if they fail on a real leak, so each is run against one.
describe("isReleased", () => {
  test("is true for dropped objects", async () => {
    expect(await isReleased(() => new WeakRef({ payload: new Array(1000).fill(0) }))).toBe(true)
  })

  test("is false while something holds every object", async () => {
    const holder: object[] = []
    const make = (): WeakRef<object> => {
      const value = {}
      holder.push(value)
      return new WeakRef(value)
    }
    expect(await isReleased(make, { attempts: 3 })).toBe(false)
    expect(holder).toHaveLength(8)
  })

  test("is false when only a minority is released", async () => {
    const holder: object[] = []
    let built = 0
    const make = (): WeakRef<object> => {
      const value = {}
      if (built++ % 4 !== 0) holder.push(value)
      return new WeakRef(value)
    }
    expect(await isReleased(make, { attempts: 3 })).toBe(false)
  })

  test("rejects an impossible threshold", async () => {
    await expect(
      isReleased(() => new WeakRef({}), { samples: 2, minCollected: 3 }),
    ).rejects.toThrow(RangeError)
  })
})

describe("heapGrowth", () => {
  test("reads near zero for a path that keeps nothing", async () => {
    const result = await heapGrowth(() => {
      const scratch = new Uint8Array(1024)
      scratch[0] = 1
    })
    expect(result.bytesPerIteration).toBeLessThan(64)
  })

  test("reads the retained size for a path that keeps 1 KiB each time", async () => {
    const kept: Uint8Array[] = []
    const result = await heapGrowth(() => {
      kept.push(new Uint8Array(1024))
    })
    expect(result.bytesPerIteration).toBeGreaterThan(900)
    expect(kept.length).toBeGreaterThan(0)
  })
})

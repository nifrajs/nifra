import { describe, expect, test } from "bun:test"
import { withCapabilityBeacon } from "../src/capabilities.ts"
import { MemoryStorage } from "../src/memory.ts"

/**
 * `StorageAdapter` is implemented outside this package, so the beacon is a wrapper rather than a method
 * on the interface - adding one would break every adapter anyone has written.
 */
describe("storage capability beacon", () => {
  const spy = () => {
    const seen: string[] = []
    return { seen, beacon: (_context: object, capability: string) => seen.push(capability) }
  }

  test("announces read for reads and write for writes", async () => {
    const { seen, beacon } = spy()
    const storage = withCapabilityBeacon(new MemoryStorage(), { beacon })
    const bound = storage.for({})
    await bound.put("a.txt", "x")
    await bound.get("a.txt")
    await bound.exists("a.txt")
    await bound.list()
    await bound.delete("a.txt")
    expect(seen).toEqual([
      "storage.write",
      "storage.read",
      "storage.read",
      "storage.read",
      "storage.write",
    ])
  })

  test("a refused capability rejects and the object is never written", async () => {
    const inner = new MemoryStorage()
    const storage = withCapabilityBeacon(inner, {
      beacon: () => {
        throw new Error("capability assurance: storage.write is not declared")
      },
    })
    await expect(storage.for({}).put("a.txt", "x")).rejects.toThrow("not declared")
    expect(await inner.exists("a.txt")).toBe(false)
  })

  test("the unwrapped path is unchanged - wrapping is not a commitment to bind every call", async () => {
    const { seen, beacon } = spy()
    const storage = withCapabilityBeacon(new MemoryStorage(), { beacon })
    await storage.put("a.txt", "x")
    expect(await storage.exists("a.txt")).toBe(true)
    expect(seen).toEqual([])
  })

  test("tokens are overridable, and a non-function beacon is refused up front", () => {
    const { seen, beacon } = spy()
    const storage = withCapabilityBeacon(new MemoryStorage(), {
      beacon,
      capabilities: { read: "blobs.read", write: "blobs.write" },
    })
    void storage.for({}).get("a.txt")
    expect(seen).toEqual(["blobs.read"])
    expect(() => withCapabilityBeacon(new MemoryStorage(), { beacon: undefined as never })).toThrow(
      /needs a beacon/,
    )
  })
})

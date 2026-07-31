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
    // Every method, not just two: the wrapper re-implements all five, so an unbound call that
    // silently stopped reaching the adapter would be invisible if only `put`/`exists` were driven.
    const { seen, beacon } = spy()
    const inner = new MemoryStorage()
    const storage = withCapabilityBeacon(inner, { beacon })

    await storage.put("a.txt", "x")
    expect(await storage.exists("a.txt")).toBe(true)
    expect(await storage.get("a.txt").then((o) => o !== null)).toBe(true)
    expect(await storage.list()).toEqual(["a.txt"])
    await storage.delete("a.txt")
    expect(await inner.exists("a.txt")).toBe(false)

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

/**
 * An adapter's OPTIONAL capabilities are the ones a hand-written wrapper forgets.
 *
 * The first version of `withCapabilityBeacon` assembled its return value from five named methods, so
 * wrapping a presignable or movable adapter silently deleted `presign`, `listPage`, `copy` and `move` -
 * a certified S3 adapter came back unable to sign a URL, with no error and no option. Forwarding is now
 * by Proxy, which cannot miss a method by construction; these tests pin the tokens and the survival.
 */
describe("optional capabilities", () => {
  class RichStorage extends MemoryStorage {
    async presign(key: string, operation: "get" | "put"): Promise<{ url: string }> {
      return { url: `https://signed/${operation}/${key}` }
    }
    async listPage(): Promise<{ keys: string[] }> {
      return { keys: ["a.txt"] }
    }
    async copy(from: string, to: string): Promise<void> {
      const object = await this.get(from)
      if (object !== null) await this.put(to, object.body)
    }
    async move(from: string, to: string): Promise<void> {
      await this.copy(from, to)
      await this.delete(from)
    }
    /** Something this module has never heard of - a provider extension. */
    async restoreFromGlacier(): Promise<string> {
      return "restoring"
    }
  }

  const spy = () => {
    const seen: string[] = []
    return { seen, beacon: (_c: object, capability: string) => seen.push(capability) }
  }

  test("every optional method survives wrapping AND binding", () => {
    const storage = withCapabilityBeacon(new RichStorage(), { beacon: () => {} })
    const bound = storage.for({})
    for (const method of ["presign", "listPage", "copy", "move", "restoreFromGlacier"] as const) {
      expect(typeof storage[method]).toBe("function")
      expect(typeof bound[method]).toBe("function")
    }
  })

  test("a PUT presign is a WRITE - it hands out write access to the bucket", async () => {
    const { seen, beacon } = spy()
    const bound = withCapabilityBeacon(new RichStorage(), { beacon }).for({})
    await bound.presign("a.txt", "get")
    await bound.presign("a.txt", "put")
    expect(seen).toEqual(["storage.read", "storage.write"])
  })

  test("listPage reads; copy and move write", async () => {
    const { seen, beacon } = spy()
    const inner = new RichStorage()
    await inner.put("a.txt", "x")
    const bound = withCapabilityBeacon(inner, { beacon }).for({})
    await bound.listPage()
    await bound.copy("a.txt", "b.txt")
    await bound.move("b.txt", "c.txt")
    expect(seen).toEqual(["storage.read", "storage.write", "storage.write"])
    expect(await inner.exists("c.txt")).toBe(true)
  })

  test("an unmapped method announces WRITE rather than nothing", async () => {
    // A declaration says what a route MAY do. An extension nobody mapped should fail closed against a
    // read-only route, not slip through unannounced.
    const { seen, beacon } = spy()
    const bound = withCapabilityBeacon(new RichStorage(), { beacon }).for({})
    await bound.restoreFromGlacier()
    expect(seen).toEqual(["storage.write"])
  })

  test("a refused capability rejects before the optional method runs", async () => {
    const inner = new RichStorage()
    await inner.put("a.txt", "x")
    const bound = withCapabilityBeacon(inner, {
      beacon: () => {
        throw new Error("capability assurance: storage.write is not declared")
      },
    }).for({})
    await expect(bound.copy("a.txt", "b.txt")).rejects.toThrow("not declared")
    expect(await inner.exists("b.txt")).toBe(false)
  })

  test("non-function properties pass through both proxies untouched", () => {
    class WithField extends MemoryStorage {
      readonly bucket = "assets"
    }
    const storage = withCapabilityBeacon(new WithField(), { beacon: () => {} })
    expect(storage.bucket).toBe("assets")
    expect(storage.for({}).bucket).toBe("assets")
    // `for` is added by the wrapper; the adapter's own members are still reported present.
    expect("for" in storage).toBe(true)
    expect("bucket" in storage).toBe(true)
    expect("nothingLikeThis" in storage).toBe(false)
  })
})

/**
 * An adapter with true `#private` fields must survive both proxies.
 *
 * A `#` field's brand check is per-instance, so reading through a proxy that passes itself as the
 * receiver throws `Cannot access invalid private field`. The first Proxy version did exactly that:
 * getters broke on both views and methods broke on the unbound one - meaning a third-party adapter
 * using `#` was fine unwrapped and broken the moment you added beacons. `StorageAdapter` exists to be
 * implemented outside this package, so "works for the adapters we happen to ship" is not the bar.
 */
describe("adapters using #private fields", () => {
  class PrivateStorage extends MemoryStorage {
    #bucket = "assets"
    get bucketName(): string {
      return this.#bucket
    }
    override async put(key: string, data: Parameters<MemoryStorage["put"]>[1]): Promise<void> {
      void this.#bucket // a wrong `this` throws here
      await super.put(key, data)
    }
  }

  test("getters and methods work on the unbound wrapper and the bound view", async () => {
    const storage = withCapabilityBeacon(new PrivateStorage(), { beacon: () => {} })
    expect(storage.bucketName).toBe("assets")
    expect(storage.for({}).bucketName).toBe("assets")
    await storage.put("a.txt", "x")
    await storage.for({}).put("b.txt", "x")
    expect(await storage.exists("a.txt")).toBe(true)
    expect(await storage.exists("b.txt")).toBe(true)
  })

  test("a detached method keeps its instance", async () => {
    const storage = withCapabilityBeacon(new PrivateStorage(), { beacon: () => {} })
    const { put } = storage
    await put("c.txt", "x")
    expect(await storage.exists("c.txt")).toBe(true)
  })
})

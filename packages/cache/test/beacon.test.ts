import { describe, expect, test } from "bun:test"
import { createCache } from "../src/cache.ts"

/**
 * A beacon makes the route's declaration evidenced by what it DOES. Static provenance says what a
 * MODULE can reach, which is as broad as the module; a call says exactly which route did what.
 *
 * The behaviour worth pinning is the failure: a `for(context)` that silently produced no evidence
 * would be the same class of bug the beacon exists to catch, so it throws instead.
 */
describe("cache capability beacon", () => {
  const spy = () => {
    const seen: Array<{ context: object; capability: string }> = []
    return {
      seen,
      beacon: (context: object, capability: string) => seen.push({ context, capability }),
    }
  }

  test("announces read before a read and write before a write", async () => {
    const { seen, beacon } = spy()
    const cache = createCache({ beacon })
    const ctx = {}
    await cache.for(ctx).set("k", 1)
    await cache.for(ctx).get("k")
    await cache.for(ctx).has("k")
    await cache.for(ctx).delete("k")
    expect(seen.map((s) => s.capability)).toEqual([
      "cache.write",
      "cache.read",
      "cache.read",
      "cache.write",
    ])
    expect(seen.every((s) => s.context === ctx)).toBe(true)
  })

  test("wrap announces both, because a miss writes", async () => {
    // Which one happens is not knowable before the call, and a declaration describes what a route MAY
    // do - so the conservative answer is the correct one.
    const { seen, beacon } = spy()
    await createCache({ beacon })
      .for({})
      .wrap("k", () => 1)
    expect(seen.map((s) => s.capability)).toEqual(["cache.read", "cache.write"])
  })

  test("announces before the operation, so a refused capability stops it happening", async () => {
    const cache = createCache({
      beacon: () => {
        throw new Error("capability assurance: cache.write is not declared")
      },
    })
    await expect(cache.for({}).set("k", 1)).rejects.toThrow("not declared")
    // The store was never touched: the beacon is a gate, not a log line.
    expect(await cache.get("k")).toBeUndefined()
  })

  test("for(context) without a beacon throws rather than producing nothing", async () => {
    expect(() => createCache().for({})).toThrow(/needs a beacon/)
  })

  test("tokens are overridable for an app that names capabilities differently", async () => {
    const { seen, beacon } = spy()
    const cache = createCache({ beacon, capabilities: { read: "kv.read", write: "kv.write" } })
    await cache.for({}).get("k")
    expect(seen[0]?.capability).toBe("kv.read")
  })

  test("the unbound cache is unchanged - no beacon, no cost", async () => {
    const { seen, beacon } = spy()
    const cache = createCache({ beacon })
    await cache.set("k", 1)
    expect(await cache.get<number>("k")).toBe(1)
    expect(seen).toEqual([])
  })
})

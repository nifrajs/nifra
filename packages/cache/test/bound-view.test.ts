import { expect, test } from "bun:test"
import { createCache } from "../src/index.ts"

test("reuses a context's view while announcing capabilities on every operation", async () => {
  const calls: Array<{ context: object; capability: string }> = []
  const cache = createCache({
    beacon: (context, capability) => {
      calls.push({ context, capability })
    },
    observer: () => undefined,
  })
  const first = {}
  const second = {}
  const view = cache.for(first)
  expect(cache.for(first)).toBe(view)
  expect(cache.for(second)).not.toBe(view)
  await view.wrap("safe:1", () => 1)
  await cache.for(first).wrap("safe:1", () => {
    throw new Error("fresh hit must not load")
  })
  expect(calls).toEqual([
    { context: first, capability: "cache.read" },
    { context: first, capability: "cache.write" },
    { context: first, capability: "cache.read" },
    { context: first, capability: "cache.write" },
  ])
})

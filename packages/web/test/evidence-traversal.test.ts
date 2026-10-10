import { expect, test } from "bun:test"
import type { BackendEvidenceProvider } from "@nifrajs/core/mount"
import { type EvidenceAncestry, traverseEvidence } from "../src/internal/evidence-traversal.ts"

// Only their identity is read: a traversal never calls the providers it records.
const provider = (): BackendEvidenceProvider => () => {
  throw new Error("not read")
}
const chainOf = (of: BackendEvidenceProvider, passed?: unknown) =>
  traverseEvidence(of, passed, async (ancestry): Promise<EvidenceAncestry> => {
    await Promise.resolve()
    return ancestry
  })
const CYCLE = /^\[nifra\/web\] cyclic composed assurance evidence mount$/

/** Run `body` as a Worker on an older compatibility date would, with no process.getBuiltinModule. */
async function withoutAsyncContext(body: () => Promise<void>): Promise<void> {
  const lookup = process.getBuiltinModule
  Reflect.set(process, "getBuiltinModule", undefined)
  try {
    await body()
  } finally {
    Reflect.set(process, "getBuiltinModule", lookup)
  }
}

test("async context refuses a cycle through a hop that drops the chain, and allows concurrent reads", async () => {
  const parent = provider()
  const concurrent = await Promise.all([chainOf(parent), chainOf(parent)])
  expect(concurrent.map((ancestry) => [...ancestry])).toEqual([[parent], [parent]])
  // The hop ignores the ancestry it is handed, as a hand-written provider may.
  await expect(traverseEvidence(parent, undefined, () => chainOf(parent))).rejects.toThrow(CYCLE)
})

test("without async context, the passed chain refuses a framework cycle and allows concurrent reads", async () => {
  const parent = provider()
  const child = provider()
  await withoutAsyncContext(async () => {
    const concurrent = await Promise.all([chainOf(parent), chainOf(parent)])
    expect(concurrent.map((ancestry) => [...ancestry])).toEqual([[parent], [parent]])
    const nested = await chainOf(child, concurrent[0])
    expect([...nested]).toEqual([parent, child])
    await expect(chainOf(parent, nested)).rejects.toThrow(CYCLE)
  })
})

test("without async context, a cycle through a hop that drops the chain stops at the in-flight cap", async () => {
  const parent = provider()
  await withoutAsyncContext(async () => {
    // A microtask-only cycle starves the test timeout, so the cycle bounds itself.
    let hops = 0
    const cycle = async (): Promise<never> => {
      await Promise.resolve()
      if (++hops > 1000) throw new Error("the cap never stopped the cycle")
      return traverseEvidence(parent, undefined, cycle)
    }
    await expect(traverseEvidence(parent, undefined, cycle)).rejects.toThrow(
      /more than 64 reads of one app in flight/,
    )
    expect(hops).toBe(64)
    // Every refused read gave its slot back, so a full set of concurrent reads still goes ahead.
    const full = await Promise.all(Array.from({ length: 64 }, () => chainOf(parent)))
    expect(full).toHaveLength(64)
  })
})

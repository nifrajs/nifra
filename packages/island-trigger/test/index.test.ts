import { describe, expect, test } from "bun:test"
import { type IslandStrategy, MAX_MEDIA_QUERY_LENGTH, scheduleTrigger } from "../src/index.ts"

describe("scheduleTrigger", () => {
  test("load fires once", () => {
    let runs = 0
    const dispose = scheduleTrigger("load", () => {
      runs++
    })
    dispose()
    expect(runs).toBe(1)
  })

  test("idle fallback is cancellable", async () => {
    const g = globalThis as { requestIdleCallback?: unknown }
    const original = g.requestIdleCallback
    g.requestIdleCallback = undefined
    try {
      let runs = 0
      const dispose = scheduleTrigger("idle", () => {
        runs++
      })
      dispose()
      await Bun.sleep(5)
      expect(runs).toBe(0)
    } finally {
      g.requestIdleCallback = original
    }
  })

  test("media runs immediately when already matching and is one-shot", () => {
    const g = globalThis as typeof globalThis & { matchMedia?: unknown }
    const original = g.matchMedia
    let listener: ((event: MediaQueryListEvent) => void) | undefined
    g.matchMedia = (() => ({
      matches: true,
      addEventListener: (_type: "change", next: (event: MediaQueryListEvent) => void) => {
        listener = next
      },
      removeEventListener: () => {},
    })) as typeof g.matchMedia
    try {
      let runs = 0
      scheduleTrigger({ media: "(min-width: 1px)" }, () => {
        runs++
      })
      listener?.({ matches: true } as MediaQueryListEvent)
      expect(runs).toBe(1)
    } finally {
      g.matchMedia = original
    }
  })

  test("media subscribes, cleans up, and rejects oversized queries", () => {
    const g = globalThis as typeof globalThis & { matchMedia?: unknown }
    const original = g.matchMedia
    let added = 0
    let removed = 0
    g.matchMedia = (() => ({
      matches: false,
      addEventListener: () => {
        added++
      },
      removeEventListener: () => {
        removed++
      },
    })) as typeof g.matchMedia
    try {
      let runs = 0
      const dispose = scheduleTrigger({ media: "(min-width: 1px)" }, () => {
        runs++
      })
      expect(added).toBe(1)
      dispose()
      expect(removed).toBe(1)
      expect(runs).toBe(0)

      scheduleTrigger({ media: "x".repeat(MAX_MEDIA_QUERY_LENGTH + 1) }, () => {
        runs++
      })
      expect(runs).toBe(0)
    } finally {
      g.matchMedia = original
    }
  })

  test("visible falls back to immediate without a target", () => {
    let runs = 0
    scheduleTrigger("visible", () => {
      runs++
    })
    expect(runs).toBe(1)
  })
})

const _typeCheck: IslandStrategy = { media: "(prefers-reduced-motion: reduce)" }
void _typeCheck

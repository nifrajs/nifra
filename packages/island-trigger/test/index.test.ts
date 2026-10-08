import { describe, expect, test } from "bun:test"
import { type IslandStrategy, MAX_MEDIA_QUERY_LENGTH, scheduleTrigger } from "../src/index.ts"

type MediaQueryChangeEvent = { readonly matches: boolean }

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
    let listener: ((event: MediaQueryChangeEvent) => void) | undefined
    g.matchMedia = (() => ({
      matches: true,
      addEventListener: (_type: "change", next: (event: MediaQueryChangeEvent) => void) => {
        listener = next
      },
      removeEventListener: () => {},
    })) as unknown as typeof g.matchMedia
    try {
      let runs = 0
      scheduleTrigger({ media: "(min-width: 1px)" }, () => {
        runs++
      })
      listener?.({ matches: true })
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
    })) as unknown as typeof g.matchMedia
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

  test("media fires at once without matchMedia, uses a legacy listener list, and stays inert without one", () => {
    const original = Reflect.get(globalThis, "matchMedia")
    try {
      let runs = 0
      Reflect.set(globalThis, "matchMedia", undefined)
      scheduleTrigger({ media: "(min-width: 1px)" }, () => {
        runs++
      })
      expect(runs).toBe(1)

      let listener: ((event: MediaQueryChangeEvent) => void) | undefined
      let removed = 0
      Reflect.set(globalThis, "matchMedia", () => ({
        matches: false,
        addListener: (next: (event: MediaQueryChangeEvent) => void) => {
          listener = next
        },
        removeListener: () => {
          removed++
        },
      }))
      scheduleTrigger({ media: "(min-width: 1px)" }, () => {
        runs++
      })
      listener?.({ matches: false })
      expect(runs).toBe(1)
      listener?.({ matches: true })
      expect({ runs, removed }).toEqual({ runs: 2, removed: 1 })

      Reflect.set(globalThis, "matchMedia", () => ({ matches: false }))
      const dispose = scheduleTrigger({ media: "(min-width: 1px)" }, () => {
        runs++
      })
      dispose()
      expect(runs).toBe(2)
    } finally {
      Reflect.set(globalThis, "matchMedia", original)
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

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

describe("interaction", () => {
  const fakeTarget = () => {
    const listeners = new Map<string, Array<() => void>>()
    const captures: boolean[] = []
    return {
      listeners,
      captures,
      addEventListener(type: string, listener: () => void, capture: boolean) {
        captures.push(capture)
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
      removeEventListener(type: string, listener: () => void, capture: boolean) {
        // A listener added for the capture phase is removed only by a capture-phase removal.
        if (!capture) return
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((l) => l !== listener),
        )
      },
      emit(type: string) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener()
      },
      count: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
    }
  }

  test("waits for hover, press, focus or click, then runs once and removes every listener", () => {
    for (const type of ["pointerover", "pointerdown", "focusin", "click"]) {
      const target = fakeTarget()
      let runs = 0
      scheduleTrigger("interaction", () => runs++, { target })
      expect(runs).toBe(0)
      expect(target.count()).toBe(4)
      expect(target.captures.every(Boolean)).toBe(true)
      target.emit(type)
      target.emit("pointerdown")
      target.emit(type)
      expect(runs).toBe(1)
      expect(target.count()).toBe(0)
    }
  })

  test("ignores events that signal no intent", () => {
    const target = fakeTarget()
    let runs = 0
    scheduleTrigger("interaction", () => runs++, { target })
    target.emit("pointerout")
    target.emit("pointerleave")
    target.emit("keydown")
    expect(runs).toBe(0)
  })

  test("the disposer cancels it before it fires", () => {
    const target = fakeTarget()
    let runs = 0
    const dispose = scheduleTrigger("interaction", () => runs++, { target })
    dispose()
    dispose()
    target.emit("pointerdown")
    expect(runs).toBe(0)
    expect(target.count()).toBe(0)
  })

  test("runs at once without a target, or with one that cannot take listeners", () => {
    let runs = 0
    scheduleTrigger("interaction", () => runs++)
    scheduleTrigger("interaction", () => runs++, { target: {} })
    expect(runs).toBe(2)
  })
})

const _typeCheck: IslandStrategy = { media: "(prefers-reduced-motion: reduce)" }
void _typeCheck

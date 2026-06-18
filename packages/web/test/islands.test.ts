import { describe, expect, mock, test } from "bun:test"
import { type IslandEnhancer, mountIslands } from "../src/islands.ts"

// mountIslands only reads `.dataset` off each element and iterates `root.querySelectorAll(...)`, so a
// minimal stub stands in for the DOM (Bun's test env has no `document`). Casts are test-only.
function island(id: string, opts: { strategy?: string; props?: string } = {}): HTMLElement {
  const dataset: Record<string, string> = { id }
  if (opts.strategy !== undefined) dataset.strategy = opts.strategy
  if (opts.props !== undefined) dataset.props = opts.props
  return { dataset } as unknown as HTMLElement
}
const rootOf = (els: HTMLElement[]): ParentNode =>
  ({ querySelectorAll: () => els }) as unknown as ParentNode

describe("mountIslands", () => {
  test("load: runs the matching enhancer synchronously with the parsed props", () => {
    let seen: unknown
    let el: HTMLElement | undefined
    mountIslands(
      {
        counter: ((e, p) => {
          el = e
          seen = p
        }) as IslandEnhancer,
      },
      { root: rootOf([island("counter", { props: '{"start":3}' })]) },
    )
    expect(seen).toEqual({ start: 3 })
    expect(el).toBeDefined()
  })

  test("an island with no registered enhancer is left inert (skipped, no throw)", () => {
    let ran = false
    expect(() =>
      mountIslands(
        {
          other: (() => {
            ran = true
          }) as IslandEnhancer,
        },
        { root: rootOf([island("unregistered")]) },
      ),
    ).not.toThrow()
    expect(ran).toBe(false)
  })

  test("malformed data-props → props is undefined (never throws)", () => {
    let seen: unknown = "untouched"
    mountIslands(
      {
        c: ((_e, p) => {
          seen = p
        }) as IslandEnhancer,
      },
      { root: rootOf([island("c", { props: "{not valid json" })]) },
    )
    expect(seen).toBeUndefined()
  })

  test("a throwing enhancer is isolated — the others still run", () => {
    const errorSpy = mock(() => {})
    const original = console.error
    console.error = errorSpy // the isolated failure is logged, not thrown — capture it quietly
    let secondRan = false
    try {
      expect(() =>
        mountIslands(
          {
            boom: (() => {
              throw new Error("island boom")
            }) as IslandEnhancer,
            ok: (() => {
              secondRan = true
            }) as IslandEnhancer,
          },
          { root: rootOf([island("boom"), island("ok")]) },
        ),
      ).not.toThrow()
    } finally {
      console.error = original
    }
    expect(secondRan).toBe(true) // the boom enhancer's throw didn't block "ok"
    expect(errorSpy).toHaveBeenCalledTimes(1) // the failure surfaced via console.error
  })

  test("dispose() runs each enhancer's returned cleanup", () => {
    let cleaned = false
    const dispose = mountIslands(
      {
        c: (() => () => {
          cleaned = true
        }) as IslandEnhancer,
      },
      { root: rootOf([island("c")]) },
    )
    expect(cleaned).toBe(false) // cleanup not called on mount
    dispose()
    expect(cleaned).toBe(true)
  })

  test("visible: defers the enhancer until intersection, then runs once; dispose disconnects", () => {
    const observed: Element[] = []
    let disconnected = false
    let captured: IntersectionObserverCallback | undefined
    let instance: FakeIO | undefined
    class FakeIO {
      constructor(cb: IntersectionObserverCallback) {
        captured = cb
        instance = this
      }
      observe(el: Element): void {
        observed.push(el)
      }
      disconnect(): void {
        disconnected = true
      }
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
    }
    const original = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver
    try {
      let runs = 0
      const dispose = mountIslands(
        {
          c: (() => {
            runs += 1
          }) as IslandEnhancer,
        },
        { root: rootOf([island("c", { strategy: "visible" })]) },
      )
      expect(observed.length).toBe(1) // observing, not yet run
      expect(runs).toBe(0)
      // Simulate the element scrolling into view — the real API passes the observer as the 2nd arg
      // (the runtime calls `obs.disconnect()`), so hand the callback our instance.
      captured?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        instance as unknown as IntersectionObserver,
      )
      expect(runs).toBe(1)
      expect(disconnected).toBe(true) // ran once → stopped observing
      dispose()
    } finally {
      globalThis.IntersectionObserver = original
    }
  })

  test("visible: a non-intersecting entry does not run the enhancer", () => {
    let captured: IntersectionObserverCallback | undefined
    let instance: FakeIO | undefined
    class FakeIO {
      constructor(cb: IntersectionObserverCallback) {
        captured = cb
        instance = this
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
    }
    const original = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver
    try {
      let runs = 0
      mountIslands(
        {
          c: (() => {
            runs += 1
          }) as IslandEnhancer,
        },
        { root: rootOf([island("c", { strategy: "visible" })]) },
      )
      captured?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        instance as unknown as IntersectionObserver,
      )
      expect(runs).toBe(0) // off-screen → still deferred
      captured?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        instance as unknown as IntersectionObserver,
      )
      expect(runs).toBe(1) // scrolled into view → runs
    } finally {
      globalThis.IntersectionObserver = original
    }
  })

  test("visible: degrades to immediate when IntersectionObserver is unavailable", () => {
    const g = globalThis as { IntersectionObserver?: unknown }
    const original = g.IntersectionObserver
    g.IntersectionObserver = undefined
    try {
      let ran = false
      mountIslands(
        {
          c: (() => {
            ran = true
          }) as IslandEnhancer,
        },
        { root: rootOf([island("c", { strategy: "visible" })]) },
      )
      expect(ran).toBe(true) // no IntersectionObserver → run now, never skip the island
    } finally {
      g.IntersectionObserver = original
    }
  })

  test("idle: defers via requestIdleCallback; dispose cancels the handle", () => {
    const g = globalThis as { requestIdleCallback?: unknown; cancelIdleCallback?: unknown }
    const origRic = g.requestIdleCallback
    const origCancel = g.cancelIdleCallback
    let scheduled: (() => void) | undefined
    let canceledHandle: number | undefined
    g.requestIdleCallback = (cb: () => void) => {
      scheduled = cb
      return 7
    }
    g.cancelIdleCallback = (handle: number) => {
      canceledHandle = handle
    }
    try {
      let ran = false
      const dispose = mountIslands(
        {
          c: (() => {
            ran = true
          }) as IslandEnhancer,
        },
        { root: rootOf([island("c", { strategy: "idle" })]) },
      )
      expect(ran).toBe(false) // deferred to idle time
      scheduled?.()
      expect(ran).toBe(true)
      dispose()
      expect(canceledHandle).toBe(7) // disposer cancels via the returned handle
    } finally {
      g.requestIdleCallback = origRic
      g.cancelIdleCallback = origCancel
    }
  })

  test("idle: falls back to setTimeout when requestIdleCallback is unavailable", async () => {
    const g = globalThis as { requestIdleCallback?: unknown }
    const origRic = g.requestIdleCallback
    g.requestIdleCallback = undefined
    try {
      let ran = false
      mountIslands(
        {
          c: (() => {
            ran = true
          }) as IslandEnhancer,
        },
        { root: rootOf([island("c", { strategy: "idle" })]) },
      )
      expect(ran).toBe(false) // not synchronous
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(ran).toBe(true) // setTimeout fallback fired
    } finally {
      g.requestIdleCallback = origRic
    }
  })
})

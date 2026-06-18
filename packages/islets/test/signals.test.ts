import { describe, expect, test } from "bun:test"
import { batch, computed, effect, signal } from "../src/signals.ts"

describe("signals core", () => {
  test("read/write + effect re-runs, functional updates", () => {
    const count = signal(0)
    const seen: number[] = []
    effect(() => seen.push(count()))
    count.set(1)
    count.set((n) => n + 1)
    expect(seen).toEqual([0, 1, 2])
  })

  test("Object.is equality skips redundant notifications", () => {
    const s = signal(1)
    let runs = 0
    effect(() => {
      s()
      runs++
    })
    s.set(1)
    expect(runs).toBe(1)
  })

  test("computed tracks through and updates dependents", () => {
    const a = signal(2)
    const b = signal(3)
    const sum = computed(() => a() + b())
    const seen: number[] = []
    effect(() => seen.push(sum()))
    a.set(10)
    expect(seen).toEqual([5, 13])
  })

  test("re-tracking: branch switches drop stale deps", () => {
    const flag = signal(true)
    const left = signal("L")
    const right = signal("R")
    let runs = 0
    effect(() => {
      runs++
      flag() ? left() : right()
    })
    right.set("R2")
    expect(runs).toBe(1)
    flag.set(false)
    expect(runs).toBe(2)
    left.set("L2")
    expect(runs).toBe(2)
    right.set("R3")
    expect(runs).toBe(3)
  })

  test("dispose stops an effect", () => {
    const s = signal(0)
    let runs = 0
    const stop = effect(() => {
      s()
      runs++
    })
    stop()
    s.set(5)
    expect(runs).toBe(1)
  })
})

describe("batch", () => {
  test("coalesces multiple writes into one effect run", () => {
    const a = signal(0)
    const b = signal(0)
    let runs = 0
    effect(() => {
      a()
      b()
      runs++
    })
    batch(() => {
      a.set(1)
      b.set(2)
      a.set(3)
    })
    expect(runs).toBe(2) // initial + ONE flush
  })

  test("nested batches flush once at the outermost end", () => {
    const s = signal(0)
    let runs = 0
    effect(() => {
      s()
      runs++
    })
    batch(() => {
      s.set(1)
      batch(() => s.set(2))
      expect(runs).toBe(1) // nothing flushed yet
    })
    expect(runs).toBe(2)
  })

  test("returns the function's value and flushes on throw", () => {
    const s = signal(0)
    let runs = 0
    effect(() => {
      s()
      runs++
    })
    expect(batch(() => 42)).toBe(42)
    expect(() =>
      batch(() => {
        s.set(1)
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(runs).toBe(2) // the write before the throw still flushed
  })

  test("an effect disposed while pending does not run on flush", () => {
    const s = signal(0)
    let runs = 0
    const stop = effect(() => {
      s()
      runs++
    })
    batch(() => {
      s.set(1)
      stop()
    })
    expect(runs).toBe(1)
  })
})

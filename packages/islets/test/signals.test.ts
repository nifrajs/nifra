import { describe, expect, test } from "bun:test"
import { batch, computed, effect, signal, untrack, watch } from "../src/signals.ts"

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

  test("a computed is not computed until something reads it", () => {
    const a = signal(1)
    let runs = 0
    const double = computed(() => {
      runs++
      return a() * 2
    })
    a.set(2)
    expect(runs).toBe(0)
    expect(double()).toBe(4)
    expect(runs).toBe(1)
  })

  test("a dropped computed stops at its input's next change instead of recomputing", () => {
    const input = signal(0)
    let runs = 0
    for (let round = 0; round < 3; round++) {
      for (let index = 0; index < 100; index++) {
        computed(() => {
          runs++
          return input()
        })()
      }
    }
    expect(runs).toBe(300)
    input.set(1)
    input.set(2)
    expect(runs).toBe(300)
  })

  test("a disposed computed stops recomputing", () => {
    const input = signal(0)
    let runs = 0
    const handles = Array.from({ length: 100 }, () =>
      computed(() => {
        runs++
        return input()
      }),
    )
    for (const handle of handles) {
      effect(() => handle())
      handle.dispose()
    }
    input.set(1)
    expect(runs).toBe(100)
  })

  test("reading a stopped or disposed computed computes it afresh", () => {
    const a = signal(1)
    const double = computed(() => a() * 2)
    expect(double()).toBe(2)
    a.set(2)
    expect(double()).toBe(4)
    double.dispose()
    a.set(3)
    expect(double()).toBe(6)
  })

  test("a computed stops once the effect reading it stops, and its own inputs one change later", () => {
    const a = signal(1)
    let innerRuns = 0
    let outerRuns = 0
    const inner = computed(() => {
      innerRuns++
      return a() + 1
    })
    const outer = computed(() => {
      outerRuns++
      return inner() * 10
    })
    const seen: number[] = []
    const stop = effect(() => seen.push(outer()))
    a.set(2)
    expect(seen).toEqual([20, 30])
    stop()
    // The first change reaches `inner` while `outer` still reads it, so `inner` recomputes once and
    // `outer` stops; the next change finds `inner` unread and stops it too.
    a.set(3)
    a.set(4)
    a.set(5)
    expect({ innerRuns, outerRuns }).toEqual({ innerRuns: 3, outerRuns: 2 })
    expect(outer()).toBe(60)
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

  test("a source read several times per run, over many runs, triggers one run per write", () => {
    const s = signal(0)
    let runs = 0
    effect(() => {
      runs++
      s() + s()
    })
    for (let i = 1; i <= 5; i++) s.set(i)
    expect(runs).toBe(6)
  })

  test("an effect that writes a signal before reading it does not requeue itself", () => {
    const trigger = signal(0)
    const doubled = signal(0)
    const seen: number[] = []
    effect(() => {
      doubled.set(trigger() * 2)
      seen.push(doubled())
    })
    trigger.set(1)
    expect(seen).toEqual([0, 2])
  })

  test("an effect that reads then writes the same signal runs again until it settles", () => {
    const s = signal(0)
    effect(() => {
      const v = s()
      if (v < 3) s.set(v + 1)
    })
    expect(s()).toBe(3)
  })

  test("untrack reads without subscribing", () => {
    const tracked = signal(1)
    const quiet = signal(10)
    let runs = 0
    effect(() => {
      runs++
      tracked()
      untrack(() => quiet())
    })
    quiet.set(11)
    expect(runs).toBe(1)
    tracked.set(2)
    expect(runs).toBe(2)
    expect(untrack(() => tracked() + quiet())).toBe(13)
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

  test("an effect sees a computed in step with its input, once per write, batched or not", () => {
    const n = signal(1)
    const twice = computed(() => n() * 2)
    const seen: number[][] = []
    effect(() => seen.push([n(), twice()]))
    batch(() => n.set(2))
    n.set(3)
    expect(seen).toEqual([
      [1, 2],
      [2, 4],
      [3, 6],
    ])
  })

  test("a diamond settles before its effect runs", () => {
    const n = signal(1)
    const left = computed(() => n() + 1)
    const right = computed(() => n() * 10)
    const sum = computed(() => left() + right())
    const seen: number[] = []
    effect(() => seen.push(sum()))
    n.set(2)
    batch(() => {
      n.set(3)
      expect(sum()).toBe(34) // a computed read inside the batch is already current
    })
    expect(seen).toEqual([12, 23, 34])
  })

  test("an effect that writes during the flush queues its subscribers instead of nesting them", () => {
    const source = signal(0)
    const mirror = signal(0)
    const runs: string[] = []
    effect(() => {
      runs.push(`mirror ${mirror()}`)
    })
    effect(() => mirror.set(source() * 2))
    effect(() => {
      runs.push(`source ${source()}`)
    })
    runs.length = 0
    source.set(1)
    expect(runs).toEqual(["source 1", "mirror 2"])
  })

  test("an effect that throws during a flush leaves the rest queued for the next flush", () => {
    const s = signal(0)
    const seen: number[] = []
    effect(() => {
      if (s() === 1) throw new Error("boom")
    })
    effect(() => {
      seen.push(s())
    })
    expect(() => s.set(1)).toThrow("boom")
    expect(seen).toEqual([0])
    batch(() => {})
    expect(seen).toEqual([0, 1])
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

  test("an effect whose input another effect writes runs again, ending on the settled values", () => {
    const source = signal(0)
    const mirror = signal(0)
    const seen: string[] = []
    const stopObserver = effect(() => {
      seen.push(`${source()}:${mirror()}`)
    })
    const stopCopy = effect(() => mirror.set(source()))
    seen.length = 0
    source.set(1)
    expect(seen).toEqual(["1:0", "1:1"])
    stopObserver()
    stopCopy()
  })
})

describe("watch (the binding walker's one-signal subscription)", () => {
  test("applies now, then once per write or batch, in step with computeds", () => {
    const n = signal(1)
    const twice = computed(() => n() * 2)
    const seen: string[] = []
    effect(() => void twice())
    watch(n, (v) => seen.push(`${v}:${twice()}`))
    n.set(2)
    batch(() => {
      n.set(3)
      n.set(4)
    })
    expect(seen).toEqual(["1:2", "2:4", "4:8"])
  })

  test("does not subscribe an effect it is created or run inside", () => {
    const s = signal(0)
    let outer = 0
    const seen: number[] = []
    effect(() => {
      outer++
      watch(s, (v) => seen.push(v))
    })
    s.set(1)
    expect(outer).toBe(1)
    expect(seen).toEqual([0, 1])
  })

  test("a stopped watch does not run, even when already queued", () => {
    const s = signal(0)
    const seen: number[] = []
    const stop = watch(s, (v) => seen.push(v))
    batch(() => {
      s.set(1)
      stop()
    })
    s.set(2)
    expect(seen).toEqual([0])
  })

  test("a signal-shaped source not made by signal() is tracked as an effect", () => {
    const inner = signal("a")
    const relay = Object.assign(() => inner(), { set: (next: string) => inner.set(next) })
    const seen: string[] = []
    watch(relay, (v) => seen.push(v))
    inner.set("b")
    expect(seen).toEqual(["a", "b"])
  })
})

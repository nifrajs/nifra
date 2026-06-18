import { expect, test } from "bun:test"
import { computed, effect, signal } from "./src/signals.ts"

test("signal read/write + effect re-runs", () => {
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

test("computed tracks through and caches into a signal", () => {
  const a = signal(2)
  const b = signal(3)
  const sum = computed(() => a() + b())
  const seen: number[] = []
  effect(() => seen.push(sum()))
  a.set(10)
  expect(seen).toEqual([5, 13])
})

test("re-tracking: branches drop stale deps", () => {
  const flag = signal(true)
  const left = signal("L")
  const right = signal("R")
  let runs = 0
  effect(() => {
    runs++
    flag() ? left() : right()
  })
  expect(runs).toBe(1)
  right.set("R2") // untracked branch — must NOT re-run
  expect(runs).toBe(1)
  flag.set(false) // switch branches
  expect(runs).toBe(2)
  left.set("L2") // now the stale branch — must NOT re-run
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

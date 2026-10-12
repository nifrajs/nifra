import { describe, expect, test } from "bun:test"
import { MemoryJobStore } from "../src/index.ts"

const seqStore = (): MemoryJobStore => {
  let n = 0
  return new MemoryJobStore({ idFor: () => `j${++n}` })
}

describe("MemoryJobStore", () => {
  test("enqueue → lease (due) → complete", () => {
    const s = seqStore()
    const id = s.enqueue({ name: "x", payload: { a: 1 }, runAt: 100, maxAttempts: 3 })
    expect(id).toBe("j1")

    const leased = s.lease(100, 10, 30_000)
    expect(leased).toEqual([
      { id: "j1", name: "x", payload: { a: 1 }, attempt: 0, maxAttempts: 3, lease: "1" },
    ])
    // Leased → hidden on a second lease at the same time.
    expect(s.lease(100, 10, 30_000)).toEqual([])

    s.complete("j1")
    expect(s.counts(100)).toEqual({ pending: 0, active: 0, dead: 0 })
  })

  test("lease respects runAt (not due yet → not returned)", () => {
    const s = seqStore()
    s.enqueue({ name: "x", payload: {}, runAt: 500, maxAttempts: 1 })
    expect(s.lease(100, 10, 1000)).toEqual([])
    expect(s.lease(500, 10, 1000)).toHaveLength(1)
  })

  test("an abandoned lease is reclaimable after leaseMs", () => {
    const s = seqStore()
    s.enqueue({ name: "x", payload: {}, runAt: 0, maxAttempts: 1 })
    s.lease(0, 10, 1000) // leased until 1000; worker "dies" (never completes)
    expect(s.lease(500, 10, 1000)).toEqual([]) // still hidden
    expect(s.lease(1000, 10, 1000)).toHaveLength(1) // lease expired → reclaimed
  })

  test("retry increments attempt + reschedules; lease sees the new attempt", () => {
    const s = seqStore()
    s.enqueue({ name: "x", payload: {}, runAt: 0, maxAttempts: 3 })
    s.lease(0, 10, 1000)
    s.retry("j1", 2000)
    expect(s.lease(1000, 10, 1000)).toEqual([]) // rescheduled to 2000
    expect(s.lease(2000, 10, 1000)).toEqual([
      { id: "j1", name: "x", payload: {}, attempt: 1, maxAttempts: 3, lease: "2" },
    ])
  })

  test("a worker whose lease was taken over cannot settle the job", () => {
    const s = seqStore()
    s.enqueue({ name: "x", payload: {}, runAt: 0, maxAttempts: 3 })
    const [first] = s.lease(0, 10, 1000)
    const [second] = s.lease(1000, 10, 1000) // the first lease ran out; another worker holds it now
    expect(first?.lease).not.toBe(second?.lease)

    s.complete("j1", first?.lease)
    s.retry("j1", 5000, first?.lease)
    s.deadLetter("j1", "late", first?.lease)
    s.renew("j1", 9000, first?.lease)
    // Still leased to the second worker, at its own expiry (2000), not the stale holder's 9000.
    expect(s.counts(1500)).toEqual({ pending: 0, active: 1, dead: 0 })
    expect(s.counts(2000)).toEqual({ pending: 1, active: 0, dead: 0 })

    s.complete("j1", second?.lease)
    expect(s.counts(2000)).toEqual({ pending: 0, active: 0, dead: 0 })
  })

  test("renew keeps a leased job hidden; a released job cannot be renewed", () => {
    const s = seqStore()
    s.enqueue({ name: "x", payload: {}, runAt: 0, maxAttempts: 3 })
    const [job] = s.lease(0, 10, 1000)
    s.renew("j1", 2500, job?.lease)
    expect(s.lease(1000, 10, 1000)).toEqual([])
    expect(s.lease(2500, 10, 1000)).toHaveLength(1)

    const [next] = s.lease(3500, 10, 1000)
    s.retry("j1", 10_000, next?.lease)
    s.renew("j1", 20_000, next?.lease) // released by the retry: nothing to renew
    expect(s.lease(10_000, 10, 1000)).toHaveLength(1)
  })

  test("deadLetter moves the job out of the active set into the dead list", () => {
    const s = seqStore()
    s.enqueue({ name: "x", payload: {}, runAt: 0, maxAttempts: 1 })
    s.lease(0, 10, 1000)
    s.deadLetter("j1", "boom")
    expect(s.counts(0)).toEqual({ pending: 0, active: 0, dead: 1 })
    expect(s.deadLetters()).toEqual([{ id: "j1", name: "x", error: "boom" }])
  })

  test("counts splits pending vs active by lease state", () => {
    const s = seqStore()
    s.enqueue({ name: "a", payload: {}, runAt: 0, maxAttempts: 1 })
    s.enqueue({ name: "b", payload: {}, runAt: 0, maxAttempts: 1 })
    s.lease(0, 1, 1000) // lease one
    expect(s.counts(0)).toEqual({ pending: 1, active: 1, dead: 0 })
  })
})

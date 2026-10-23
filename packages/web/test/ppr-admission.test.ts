import { describe, expect, test } from "bun:test"
import {
  type AdmissionTimers,
  HoleAdmission,
  type HoleSlot,
} from "../src/internal/ppr/admission.ts"

/** A clock and timer the test advances by hand. */
const manualTimers = () => {
  let now = 0
  let seq = 0
  const due = new Map<number, { readonly at: number; readonly fn: () => void }>()
  const timers: AdmissionTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      due.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") due.delete(handle)
    },
  }
  return {
    timers,
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...due]) {
        if (timer.at <= now) {
          due.delete(id)
          timer.fn()
        }
      }
    },
  }
}

const OPTIONS = {
  boundaryAbandonedTrip: 3,
  processAbandonedTrip: 5,
  admissionStop: 8,
  abandonGraceMs: 100,
  maxHoleWork: 100,
}

const slotOf = (admission: HoleAdmission): HoleSlot => {
  const slot = admission.slot()
  if (slot === undefined) throw new Error("no free slot")
  return slot
}

const never = (): Promise<never> => new Promise<never>(() => {})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Start `count` responses whose single hole `key` never settles, abort them, pass the grace. */
async function abandon(
  admission: HoleAdmission,
  clock: ReturnType<typeof manualTimers>,
  key: string,
  count: number,
): Promise<void> {
  const controllers: AbortController[] = []
  for (let i = 0; i < count; i++) {
    const slot = slotOf(admission)
    const controller = new AbortController()
    controllers.push(controller)
    void slot.run(key, controller.signal, never)
    slot.seal()
  }
  await tick()
  for (const controller of controllers) controller.abort()
  clock.advance(OPTIONS.abandonGraceMs + 1)
}

describe("PPR hole admission", () => {
  test("a boundary at its trip point is denied without invocation; siblings stay admitted", async () => {
    const clock = manualTimers()
    const admission = new HoleAdmission(OPTIONS, undefined, clock.timers)
    await abandon(admission, clock, "p|bad", 3)
    expect(admission.stats().abandonedBy).toEqual({ "p|bad": 3 })

    let invoked = 0
    const slot = slotOf(admission)
    const signal = new AbortController().signal
    const bad = await slot.run("p|bad", signal, () => {
      invoked++
      return 1
    })
    const sibling = await slot.run("p|good", signal, () => 2)
    const other = await slot.run("q|good", signal, () => 3)
    slot.seal()
    expect(bad).toEqual({ ok: false, reason: "denied" })
    expect(invoked).toBe(0)
    expect(sibling).toEqual({ ok: true, value: 2 })
    expect(other).toEqual({ ok: true, value: 3 })
    expect(admission.stats().denied).toEqual({ stop: 0, process: 0, boundary: 1 })
  })

  test("at the process trip point only boundaries holding abandoned work are denied", async () => {
    const clock = manualTimers()
    const admission = new HoleAdmission(OPTIONS, undefined, clock.timers)
    await abandon(admission, clock, "a", 2)
    await abandon(admission, clock, "b", 2)
    await abandon(admission, clock, "c", 1)
    expect(admission.stats().abandoned).toBe(5)
    const slot = slotOf(admission)
    const signal = new AbortController().signal
    expect(await slot.run("c", signal, () => 1)).toEqual({ ok: false, reason: "denied" })
    expect(await slot.run("fresh", signal, () => 1)).toEqual({ ok: true, value: 1 })
    expect(admission.stats().denied.process).toBe(1)
  })

  test("the global stop denies every hole and reports itself", async () => {
    const clock = manualTimers()
    const admission = new HoleAdmission(OPTIONS, undefined, clock.timers)
    for (const key of ["a", "b", "c", "d"]) await abandon(admission, clock, key, 2)
    expect(admission.stats().admissionStopped).toBe(true)
    const slot = slotOf(admission)
    expect(await slot.run("fresh", new AbortController().signal, () => 1)).toEqual({
      ok: false,
      reason: "denied",
    })
    expect(admission.stats().denied.stop).toBe(1)
  })

  test("settling an abandoned promise readmits its boundary below the trip point", async () => {
    const clock = manualTimers()
    const admission = new HoleAdmission(OPTIONS, undefined, clock.timers)
    await abandon(admission, clock, "x", 2)
    let release!: () => void
    const slot = slotOf(admission)
    const controller = new AbortController()
    void slot.run("x", controller.signal, () => new Promise<void>((r) => (release = r)))
    slot.seal()
    await tick()
    controller.abort()
    clock.advance(101)
    expect(admission.denial("x")).toBe("boundary")
    release()
    await tick()
    expect(admission.stats().abandonedBy).toEqual({ x: 2 })
    expect(admission.denial("x")).toBeUndefined()
  })

  test("a loader that settles within the grace after its abort is never abandoned", async () => {
    const clock = manualTimers()
    const admission = new HoleAdmission(OPTIONS, undefined, clock.timers)
    let release!: () => void
    const slot = slotOf(admission)
    const controller = new AbortController()
    const run = slot.run("x", controller.signal, () => new Promise<void>((r) => (release = r)))
    slot.seal()
    await tick()
    controller.abort()
    expect(await run).toMatchObject({ ok: false, reason: "aborted" })
    clock.advance(99)
    release()
    await tick()
    clock.advance(10)
    expect(admission.stats()).toMatchObject({ abandoned: 0, pending: 0, slotsInUse: 0 })
  })

  test("an aborted run answers at once even when the loader ignores its signal", async () => {
    const admission = new HoleAdmission(OPTIONS, undefined, manualTimers().timers)
    const slot = slotOf(admission)
    const controller = new AbortController()
    const run = slot.run("x", controller.signal, never)
    controller.abort()
    expect(await run).toMatchObject({ ok: false, reason: "aborted" })
    const failed = await slot.run("y", new AbortController().signal, () => {
      throw new Error("boom")
    })
    expect(failed).toMatchObject({ ok: false, reason: "failed" })
  })

  test("no free slot sheds the response; a slot frees exactly once when its holes are done", async () => {
    const clock = manualTimers()
    const admission = new HoleAdmission({ ...OPTIONS, maxHoleWork: 4 }, undefined, clock.timers)
    const slots = [1, 2, 3, 4].map(() => slotOf(admission))
    expect(admission.slot()).toBeUndefined()
    expect(admission.stats()).toMatchObject({ shed: 1, slotsInUse: 4 })

    // Ends before starting any hole: frees at once, and only once.
    slots[0]?.seal()
    slots[0]?.seal()
    expect(admission.stats().slotsInUse).toBe(3)

    // Settles: frees when the loader settles.
    let release!: () => void
    void slots[1]?.run(
      "a",
      new AbortController().signal,
      () => new Promise<void>((r) => (release = r)),
    )
    slots[1]?.seal()
    await tick()
    expect(admission.stats().slotsInUse).toBe(3)
    release()
    await tick()
    expect(admission.stats().slotsInUse).toBe(2)

    // Abandoned: frees once the grace passes, though the promise never settles.
    const controller = new AbortController()
    void slots[2]?.run("b", controller.signal, never)
    slots[2]?.seal()
    await tick()
    controller.abort()
    expect(admission.stats().slotsInUse).toBe(2)
    clock.advance(101)
    expect(admission.stats()).toMatchObject({ slotsInUse: 1, abandoned: 1, pending: 1 })
    expect(admission.slot()).toBeDefined()
  })

  test("overshoot: responses live when a boundary crosses its trip stay within trip - 1 + R", async () => {
    const clock = manualTimers()
    const admission = new HoleAdmission(OPTIONS, undefined, clock.timers)
    // R = 5 responses admitted before any is abandoned: all five may become abandoned.
    await abandon(admission, clock, "x", 5)
    expect(admission.stats().abandonedBy.x).toBe(5)
    expect(5).toBeLessThanOrEqual(OPTIONS.boundaryAbandonedTrip - 1 + 5)
    expect(admission.denial("x")).toBe("process")
  })

  test("a loader settling after the grace is reported once", async () => {
    const clock = manualTimers()
    const late: Array<[string, number]> = []
    const admission = new HoleAdmission(OPTIONS, (key, ms) => late.push([key, ms]), clock.timers)
    let release!: () => void
    const slot = slotOf(admission)
    const controller = new AbortController()
    void slot.run("x", controller.signal, () => new Promise<void>((r) => (release = r)))
    slot.seal()
    await tick()
    controller.abort()
    clock.advance(250)
    release()
    await tick()
    expect(late).toEqual([["x", 250]])
  })
})

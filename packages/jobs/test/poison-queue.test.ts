import { describe, expect, test } from "bun:test"
import { fixedBackoff } from "../src/backoff.ts"
import { toDeadLetterView, toQueueHealth } from "../src/dead-letter-view.ts"
import { createQueue, MemoryJobStore } from "../src/index.ts"

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let ms = start
  return { now: () => ms, advance: (d) => (ms += d) }
}

describe("poison queue - an always-failing job cannot wedge the queue", () => {
  test("poison is quarantined after attempts, the worker loop survives, siblings complete", async () => {
    const clock = makeClock()
    const store = new MemoryJobStore()
    const errors: string[] = []
    const q = createQueue({ store, now: clock.now, onError: (_e, name) => errors.push(name) })
    let attempts = 0
    q.define("poison", {
      retries: { attempts: 3, backoff: fixedBackoff(0) },
      handler() {
        attempts++
        throw new Error("poison: every attempt fails")
      },
    })
    let siblingDone = false
    const sibling = q.define("sibling-ok", {
      handler() {
        siblingDone = true
      },
    })

    await q.enqueue("poison", { orderId: "secret-123" })
    await sibling.enqueue({})
    // drain loops until nothing is due: poison attempt 1, 2, 3 then dead-letter; sibling runs.
    await q.drain()

    expect(attempts).toBe(3)
    expect(errors).toEqual(["poison", "poison", "poison"])
    expect(siblingDone).toBe(true)
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 1 })
  })

  test("quarantine is observable through the content-free projection only", async () => {
    const clock = makeClock()
    const store = new MemoryJobStore()
    const q = createQueue({ store, now: clock.now, onError: () => {} })
    q.define("poison", {
      retries: 1,
      handler() {
        throw new Error("poison")
      },
    })
    await q.enqueue("poison", { orderId: "secret-123" })
    await q.drain()

    const health = toQueueHealth(await q.counts())
    expect(health).toEqual({ pending: 0, active: 0, dead: 1 })
    const views = toDeadLetterView(store.deadLetters())
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ name: "poison" })
    expect(Object.keys(views[0] ?? {}).sort()).toEqual(["errorFingerprint", "id", "name"])
    // The payload and the error text stay server-side - the view carries neither.
    // (The job *name* is safe identity and is expected in the view.)
    expect(JSON.stringify(views)).not.toContain("secret-123")
    expect(JSON.stringify(health)).not.toContain("secret-123")
  })

  test("a poisoned queue still accepts and runs new work", async () => {
    const clock = makeClock()
    const store = new MemoryJobStore()
    const q = createQueue({ store, now: clock.now, onError: () => {} })
    q.define("poison", {
      retries: 1,
      handler() {
        throw new Error("poison")
      },
    })
    let ran = false
    const later = q.define("later-ok", {
      handler() {
        ran = true
      },
    })
    await q.enqueue("poison", {})
    await q.drain()
    await later.enqueue({})
    expect(await q.drain()).toBe(1)
    expect(ran).toBe(true)
  })
})

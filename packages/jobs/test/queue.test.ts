import { describe, expect, test } from "bun:test"
import { fixedBackoff } from "../src/backoff.ts"
import { createQueue, JobError, JobValidationError } from "../src/index.ts"
import type { StandardSchemaV1 } from "../src/types.ts"

/** A mutable injectable clock so retry/backoff/delay tests are deterministic (no real timers). */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let ms = start
  return { now: () => ms, advance: (d) => (ms += d) }
}

/** A tiny Standard Schema that requires `{ to: string }` — exercises validation without a dep. */
const toSchema: StandardSchemaV1<{ to: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v) =>
      typeof v === "object" && v !== null && typeof (v as { to?: unknown }).to === "string"
        ? { value: v as { to: string } }
        : { issues: [{ message: "to must be a string" }] },
  },
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe("createQueue — define + enqueue + run", () => {
  test("drain runs the typed handler with payload + ctx", async () => {
    const clock = makeClock()
    const q = createQueue({ now: clock.now })
    const seen: Array<{ to: string; attempt: number }> = []
    const send = q.define("send", {
      async handler(p: { to: string }, ctx) {
        seen.push({ to: p.to, attempt: ctx.attempt })
      },
    })
    await send.enqueue({ to: "a@b.com" })
    expect(await q.drain()).toBe(1)
    expect(seen).toEqual([{ to: "a@b.com", attempt: 1 }])
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 0 })
  })

  test("enqueue validates against the input schema (rejects bad, accepts good)", async () => {
    const q = createQueue()
    const send = q.define("send", { input: toSchema, handler() {} })
    await expect(send.enqueue({ to: 123 as unknown as string })).rejects.toBeInstanceOf(
      JobValidationError,
    )
    await expect(send.enqueue({ to: "ok" })).resolves.toBeString()
  })

  test("unknown job + duplicate define throw", async () => {
    const q = createQueue()
    q.define("a", { handler() {} })
    expect(() => q.define("a", { handler() {} })).toThrow(JobError)
    await expect(q.enqueue("missing", {})).rejects.toBeInstanceOf(JobError)
  })
})

describe("createQueue — retries + dead-letter", () => {
  test("retries a throwing handler after backoff, then succeeds", async () => {
    const clock = makeClock()
    let calls = 0
    const q = createQueue({ now: clock.now, onError: () => {} })
    const job = q.define("flaky", {
      retries: { attempts: 3, backoff: fixedBackoff(1000) },
      handler() {
        calls += 1
        if (calls < 2) throw new Error("boom")
      },
    })
    await job.enqueue({})

    expect(await q.drain()).toBe(1) // attempt 1 → throws → retry scheduled at now+1000
    expect(calls).toBe(1)
    expect(await q.counts()).toMatchObject({ dead: 0 })
    expect(await q.drain()).toBe(0) // not due yet (backoff in the future)

    clock.advance(1000)
    expect(await q.drain()).toBe(1) // attempt 2 → succeeds
    expect(calls).toBe(2)
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 0 })
  })

  test("dead-letters after exhausting attempts; onError fires each time", async () => {
    const clock = makeClock()
    const errors: string[] = []
    const q = createQueue({
      now: clock.now,
      onError: (_e, name) => errors.push(name),
    })
    const job = q.define("always-fails", {
      retries: { attempts: 2, backoff: fixedBackoff(0) },
      handler() {
        throw new Error("nope")
      },
    })
    await job.enqueue({})
    await q.drain() // attempt 1 → retry (backoff 0 → due immediately, but drain re-leases within the loop)
    // drain loops until empty: attempt 1 retry@now, attempt 2 → dead-letter
    expect(errors).toEqual(["always-fails", "always-fails"])
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 1 })
  })
})

describe("createQueue — scheduling", () => {
  test("a delayed job is not run before its runAt", async () => {
    const clock = makeClock()
    const q = createQueue({ now: clock.now })
    let ran = false
    const job = q.define("later", {
      handler() {
        ran = true
      },
    })
    await job.enqueue({}, { delayMs: 5000 })

    expect(await q.drain()).toBe(0)
    expect(ran).toBe(false)
    clock.advance(5000)
    expect(await q.drain()).toBe(1)
    expect(ran).toBe(true)
  })

  test("error isolation: a failing job (attempts:1) is dead-lettered while a sibling completes", async () => {
    const clock = makeClock()
    const q = createQueue({ now: clock.now, onError: () => {} })
    let bDone = false
    q.define("a-fails", {
      retries: 1,
      handler() {
        throw new Error("x")
      },
    })
    q.define("b-ok", {
      handler() {
        bDone = true
      },
    })
    await q.enqueue("a-fails", {})
    await q.enqueue("b-ok", {})

    await q.drain()
    expect(bDone).toBe(true)
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 1 })
  })
})

describe("createQueue — worker lifecycle (real timers)", () => {
  test("start() processes enqueued jobs; stop() drains the in-flight round", async () => {
    const q = createQueue() // real clock
    const gate = deferred()
    let finished = false
    const job = q.define("slow", {
      async handler() {
        await gate.promise
        finished = true
      },
    })
    await job.enqueue({})

    const worker = q.start({ pollIntervalMs: 5 })
    expect(worker.running).toBe(true)
    await Bun.sleep(30) // let the worker lease + enter the handler (now awaiting the gate)
    expect(finished).toBe(false)

    const stopping = worker.stop() // must await the in-flight handler
    gate.resolve()
    await stopping
    expect(finished).toBe(true)
    expect(worker.running).toBe(false)
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 0 })
  })
})

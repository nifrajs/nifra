import { describe, expect, test } from "bun:test"
import { fixedBackoff, noBackoff } from "../src/backoff.ts"
import { createQueue, JobError, JobTimeoutError, JobValidationError } from "../src/index.ts"
import { MemoryJobStore } from "../src/memory-store.ts"
import type { JobStore, StandardSchemaV1, StoredJob } from "../src/types.ts"

/** A mutable injectable clock so retry/backoff/delay tests are deterministic (no real timers). */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let ms = start
  return { now: () => ms, advance: (d) => (ms += d) }
}

/** A tiny Standard Schema that requires `{ to: string }` - exercises validation without a dep. */
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

describe("createQueue - define + enqueue + run", () => {
  test("rejects invalid worker limits", () => {
    const q = createQueue()
    expect(() => q.start({ concurrency: Number.NaN })).toThrow(/concurrency/)
    expect(() => q.start({ pollIntervalMs: Number.NaN })).toThrow(/pollIntervalMs/)
    expect(() => q.start({ leaseMs: Number.POSITIVE_INFINITY })).toThrow(/leaseMs/)
  })

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

  test("attempt counts must be whole numbers, so a failing job cannot retry forever", async () => {
    const q = createQueue()
    for (const retries of [Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
      expect(() => q.define(`n${retries}`, { retries, handler() {} })).toThrow(RangeError)
      expect(() =>
        q.define(`p${retries}`, { retries: { attempts: retries }, handler() {} }),
      ).toThrow(/retries\.attempts must be a whole number/)
    }
    expect(() => createQueue({ defaultAttempts: Number.NaN })).toThrow(/defaultAttempts/)
    expect(() => createQueue({ defaultAttempts: 1.5 })).toThrow(RangeError)

    // Below 1 still means one attempt: the job dead-letters on its first failure.
    const clock = makeClock()
    const once = createQueue({ now: clock.now, onError: () => {}, defaultAttempts: 0 })
    once.define("fails", {
      handler() {
        throw new Error("no")
      },
    })
    await once.enqueue("fails", {})
    await once.drain()
    expect(await once.counts()).toEqual({ pending: 0, active: 0, dead: 1 })
  })

  test("unknown job + duplicate define throw", async () => {
    const q = createQueue()
    q.define("a", { handler() {} })
    expect(() => q.define("a", { handler() {} })).toThrow(JobError)
    await expect(q.enqueue("missing", {})).rejects.toBeInstanceOf(JobError)
  })
})

describe("createQueue - retries + dead-letter", () => {
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

// A store compares eligibility with `<=`, never true for NaN: such a job was written, counted as
// pending forever, and never ran, retried or dead-lettered.
describe("createQueue - non-finite schedules", () => {
  test("a non-finite delayMs or runAt is refused before the job is written", async () => {
    const q = createQueue({ now: makeClock().now })
    const job = q.define("later", { handler() {} })
    for (const opts of [
      { delayMs: Number.NaN },
      { delayMs: Number.POSITIVE_INFINITY },
      { runAt: Number.NaN },
      { runAt: Number.POSITIVE_INFINITY },
    ]) {
      await expect(job.enqueue({}, opts)).rejects.toThrow(/finite number of milliseconds/)
    }
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 0 })
  })

  test("a backoff that returns a non-finite delay dead-letters the job instead of stranding it", async () => {
    const errors: unknown[] = []
    const q = createQueue({ now: makeClock().now, onError: (error) => errors.push(error) })
    let calls = 0
    const job = q.define("bad-backoff", {
      retries: { attempts: 3, backoff: () => Number.NaN },
      handler() {
        calls += 1
        throw new Error("boom")
      },
    })
    await job.enqueue({})
    await q.drain()
    expect(calls).toBe(1)
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 1 })
    expect(
      errors.some((e) => e instanceof RangeError && /not a finite delay/.test(e.message)),
    ).toBe(true)
  })
})

describe("createQueue - scheduling", () => {
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

describe("a store that fails to record a success", () => {
  for (const retries of [3, 1])
    test(`never reruns or dead-letters the finished handler (retries: ${retries})`, async () => {
      class LossyStore extends MemoryJobStore {
        override async complete(): Promise<void> {
          throw new Error("store down")
        }
      }
      const store = new LossyStore()
      const q = createQueue({ store, backoff: noBackoff, onError: () => {} })
      let runs = 0
      q.define("send", {
        retries,
        handler() {
          runs++
        },
      })
      await q.enqueue("send", {})
      await expect(q.drain()).rejects.toThrow("store down")
      expect(runs).toBe(1)
      expect(await q.counts()).toEqual({ pending: 0, active: 1, dead: 0 })
    })
})

describe("createQueue - worker lifecycle (real timers)", () => {
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

describe("a job holds its slot until it settles", () => {
  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  test("a store failure in one job does not end the round while a sibling still runs", async () => {
    const failed = deferred()
    class DeadLetterOutage extends MemoryJobStore {
      override deadLetter(): void {
        failed.resolve()
        throw new Error("dead-letter store unavailable")
      }
    }
    const q = createQueue({ store: new DeadLetterOutage(), onError: () => {} })
    const started = deferred()
    const gate = deferred()
    const job = q.define<{ fail: boolean }>("audit", {
      retries: 1,
      async handler({ fail }) {
        if (fail) throw new Error("boom")
        started.resolve()
        await gate.promise
      },
    })
    await job.enqueue({ fail: true })
    await job.enqueue({ fail: false })
    const worker = q.start({ concurrency: 2, pollIntervalMs: 60_000 })
    const round = q.process()
    const outcome = round.then(
      () => "resolved",
      (error: unknown) => String(error),
    )
    await Promise.all([failed.promise, started.promise])
    await turn()
    let waited = false
    const second = q.process().then((n) => {
      waited = true
      return n
    })
    let stopped = false
    const stopping = worker.stop().then(() => {
      stopped = true
    })
    await turn()
    expect(stopped).toBe(false)
    expect(waited).toBe(false)
    gate.resolve()
    expect(await outcome).toContain("dead-letter store unavailable")
    expect(await second).toBe(1)
    await stopping
  })

  test("concurrent drains run no more than the configured concurrency", async () => {
    const q = createQueue()
    const gate = deferred()
    let live = 0
    let peak = 0
    const job = q.define("audit", {
      async handler() {
        live++
        peak = Math.max(peak, live)
        await gate.promise
        live--
      },
    })
    for (let i = 0; i < 3; i++) await job.enqueue({})
    const drains = Promise.all([q.drain(), q.drain(), q.drain()])
    await turn()
    expect(live).toBe(1)
    gate.resolve()
    await drains
    expect(peak).toBe(1)
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 0 })
  })
})

describe("a slow job holds only its own slot", () => {
  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  test("process() runs the next due job in a free slot instead of waiting on the slow one", async () => {
    const q = createQueue()
    const slowStarted = deferred()
    const gate = deferred()
    const ran: string[] = []
    const slow = q.define("slow", {
      async handler() {
        slowStarted.resolve()
        await gate.promise
        ran.push("slow")
      },
    })
    const fast = q.define<number>("fast", {
      handler(n) {
        ran.push(`fast${n}`)
      },
    })
    await slow.enqueue({})
    const worker = q.start({ concurrency: 2, pollIntervalMs: 60_000 })
    const first = q.process()
    await slowStarted.promise
    await fast.enqueue(1)
    await fast.enqueue(2)
    const blocked = turn().then(() => "blocked")
    expect(await Promise.race([q.process(), blocked])).toBe(1)
    expect(await Promise.race([q.process(), blocked])).toBe(1)
    expect(ran).toEqual(["fast1", "fast2"])
    gate.resolve()
    expect(await first).toBe(1)
    await worker.stop()
    expect(ran).toEqual(["fast1", "fast2", "slow"])
  })

  test("the worker fills a free slot while a slow job runs, and stop() waits for both", async () => {
    const q = createQueue()
    const slowStarted = deferred()
    const fastRan = deferred()
    const gate = deferred()
    let slowDone = false
    const slow = q.define("slow", {
      async handler() {
        slowStarted.resolve()
        await gate.promise
        slowDone = true
      },
    })
    const fast = q.define("fast", {
      handler() {
        fastRan.resolve()
      },
    })
    await slow.enqueue({})
    const worker = q.start({ concurrency: 2, pollIntervalMs: 1 })
    await slowStarted.promise
    await fast.enqueue({})
    await fastRan.promise
    expect(slowDone).toBe(false)
    const stopping = worker.stop()
    gate.resolve()
    await stopping
    expect(slowDone).toBe(true)
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 0 })
  })
})

describe("timeoutMs", () => {
  test("an attempt that outruns it fails with JobTimeoutError and aborts ctx.signal", async () => {
    const errors: unknown[] = []
    const q = createQueue({ backoff: noBackoff, onError: (error) => errors.push(error) })
    let signal: AbortSignal | undefined
    const hung = q.define("hung", {
      retries: 1,
      timeoutMs: 1,
      handler(_payload, ctx) {
        signal = ctx.signal
        return new Promise<void>(() => {})
      },
    })
    await hung.enqueue({})
    expect(await q.drain()).toBe(1)
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 1 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(JobTimeoutError)
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBe(errors[0])
  })

  test("a timed-out attempt is retried, and a handler that rejects on abort is not unhandled", async () => {
    const errors: unknown[] = []
    const q = createQueue({ backoff: noBackoff, onError: (error) => errors.push(error) })
    let attempts = 0
    const job = q.define("flaky", {
      retries: 2,
      timeoutMs: 1,
      handler(_payload, ctx) {
        attempts++
        if (ctx.attempt === 2) return
        return new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(new Error("aborted late")))
        })
      },
    })
    await job.enqueue({})
    await q.drain()
    expect(attempts).toBe(2)
    expect(errors.map(String)).toEqual(['JobTimeoutError: job "flaky" did not finish within 1ms'])
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 0 })
  })

  test("a job without one gets no signal", async () => {
    const q = createQueue()
    let keys: string[] = []
    const job = q.define("plain", {
      handler(_payload, ctx) {
        keys = Object.keys(ctx)
      },
    })
    await job.enqueue({})
    await q.drain()
    expect(keys).toEqual(["id", "name", "attempt"])
  })

  test("define rejects a timeoutMs setTimeout cannot honour", () => {
    const q = createQueue()
    const handler = (): void => {}
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])
      expect(() => q.define(`t${timeoutMs}`, { timeoutMs, handler })).toThrow(RangeError)
    expect(() => q.define("ok", { timeoutMs: 2 ** 31 - 1, handler })).not.toThrow()
  })
})

describe("worker polling survives a failing store", () => {
  test("without onPollError a failed poll is logged, and stop() waits out the failing round", async () => {
    const memory = new MemoryJobStore()
    const leasing = deferred()
    const gate = Promise.withResolvers<StoredJob[]>()
    const store: JobStore = {
      enqueue: (job) => memory.enqueue(job),
      lease: () => {
        leasing.resolve()
        return gate.promise
      },
      complete: (id) => memory.complete(id),
      retry: (id, runAt) => memory.retry(id, runAt),
      deadLetter: (id, error) => memory.deadLetter(id, error),
      counts: () => memory.counts(),
    }
    const logged: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }
    try {
      const worker = createQueue({ store }).start({ pollIntervalMs: 5 })
      await leasing.promise
      const stopping = worker.stop()
      gate.reject(new Error("db connection reset"))
      await stopping
      expect(worker.running).toBe(false)
      expect(logged.some((args) => String(args[1]).includes("db connection reset"))).toBe(true)
    } finally {
      console.error = original
    }
  })

  test("a lease that throws is reported to onPollError and the next poll still runs jobs", async () => {
    class FlakyStore extends MemoryJobStore {
      failures = 1
      override lease(now: number, limit: number, leaseMs: number) {
        if (this.failures > 0) {
          this.failures--
          throw new Error("db connection reset")
        }
        return super.lease(now, limit, leaseMs)
      }
    }
    const q = createQueue({ store: new FlakyStore() })
    const ran = deferred()
    const send = q.define("send", {
      handler() {
        ran.resolve()
      },
    })
    await send.enqueue({})
    const reported: unknown[] = []
    const worker = q.start({ pollIntervalMs: 5, onPollError: (error) => reported.push(error) })
    await ran.promise
    await worker.stop()
    expect(reported).toHaveLength(1)
    expect(String(reported[0])).toContain("db connection reset")
  })
})

describe("a job that outruns its lease", () => {
  /** Resolves on the next `lease` call that hands back `id`. */
  function leaseWatch(store: MemoryJobStore, id: string): { next: () => Promise<void> } {
    let waiter: (() => void) | undefined
    const lease = store.lease.bind(store)
    store.lease = (now, limit, leaseMs) => {
      const leased = lease(now, limit, leaseMs)
      if (leased.some((job) => job.id === id)) waiter?.()
      return leased
    }
    return {
      next: () =>
        new Promise<void>((resolve) => {
          waiter = resolve
        }),
    }
  }

  test("is not started a second time when its own worker leases it again", async () => {
    const clock = makeClock()
    const memory = new MemoryJobStore({ idFor: () => "j1" })
    const watch = leaseWatch(memory, "j1")
    // No `renew`: the lease runs out mid-run, the case only the in-process hold covers.
    const store: JobStore = {
      enqueue: (job) => memory.enqueue(job),
      lease: (now, limit, leaseMs) => memory.lease(now, limit, leaseMs),
      complete: (id, lease) => memory.complete(id, lease),
      retry: (id, runAt, lease) => memory.retry(id, runAt, lease),
      deadLetter: (id, error, lease) => memory.deadLetter(id, error, lease),
      counts: () => memory.counts(clock.now()),
    }
    const q = createQueue({ store, now: clock.now })
    const started = deferred()
    const gate = deferred()
    let runs = 0
    q.define("slow", {
      async handler() {
        runs++
        started.resolve()
        await gate.promise
      },
    })
    const leasedAgain = watch.next()
    await q.enqueue("slow", {})
    const worker = q.start({ concurrency: 2, leaseMs: 100, pollIntervalMs: 1 })
    await started.promise
    await leasedAgain // the first lease
    const relet = watch.next()
    clock.advance(101)
    await relet
    expect(runs).toBe(1)
    gate.resolve()
    await worker.stop()
    expect(runs).toBe(1)
    // It settled under the lease it was handed again, so the store accepted the completion.
    expect(await q.counts()).toEqual({ pending: 0, active: 0, dead: 0 })
  })

  test("keeps its lease while it runs, so another worker cannot take it", async () => {
    const clock = makeClock()
    let renewed: (() => void) | undefined
    class RenewingStore extends MemoryJobStore {
      override renew(id: string, until: number, lease?: string): void {
        super.renew(id, until, lease)
        renewed?.()
      }
    }
    const store = new RenewingStore()
    const nextRenewal = () =>
      new Promise<void>((resolve) => {
        renewed = resolve
      })
    const started = deferred()
    const gate = deferred()
    let runs = 0
    const handler = async (): Promise<void> => {
      runs++
      started.resolve()
      await gate.promise
    }
    const owner = createQueue({ store, now: clock.now })
    owner.define("slow", { handler })
    const other = createQueue({ store, now: clock.now })
    other.define("slow", { handler })
    await owner.enqueue("slow", {})
    const worker = owner.start({ leaseMs: 30, pollIntervalMs: 1 })
    await started.promise
    const renewal = nextRenewal()
    clock.advance(20)
    await renewal // renewed at +20 to +50
    clock.advance(20) // +40: past the first lease's +30
    expect(await other.process()).toBe(0)
    expect(runs).toBe(1)
    gate.resolve()
    await worker.stop()
    expect(store.counts(clock.now())).toEqual({ pending: 0, active: 0, dead: 0 })
  })

  test("a renewal that fails is reported to onPollError, and the job still completes", async () => {
    const reportedOnce = deferred()
    class DownStore extends MemoryJobStore {
      override renew(): void {
        throw new Error("renew down")
      }
    }
    const store = new DownStore()
    const q = createQueue({ store })
    const gate = deferred()
    q.define("slow", {
      async handler() {
        await gate.promise
      },
    })
    await q.enqueue("slow", {})
    const reported: unknown[] = []
    const worker = q.start({
      leaseMs: 3,
      pollIntervalMs: 1,
      onPollError: (error) => {
        reported.push(error)
        reportedOnce.resolve()
      },
    })
    await reportedOnce.promise
    gate.resolve()
    await worker.stop()
    expect(String(reported[0])).toContain("renew down")
    expect(store.counts()).toEqual({ pending: 0, active: 0, dead: 0 })
  })

  test("start() refuses a timeoutMs that is not below leaseMs, before and after it starts", async () => {
    const q = createQueue()
    q.define("slow", { timeoutMs: 1000, handler() {} })
    expect(() => q.start({ leaseMs: 1000 })).toThrow(/timeoutMs \(1000\) must be below/)
    const worker = q.start({ leaseMs: 1001, pollIntervalMs: 1_000 })
    try {
      expect(() => q.define("later", { timeoutMs: 1001, handler() {} })).toThrow(/leaseMs \(1001\)/)
      expect(() => q.define("fits", { timeoutMs: 1000, handler() {} })).not.toThrow()
    } finally {
      await worker.stop()
    }
  })
})

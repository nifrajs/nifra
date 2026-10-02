import { describe, expect, test } from "bun:test"
import { fixedBackoff } from "../src/backoff.ts"
import {
  createQueue,
  type JobContext,
  JobError,
  type JobRunOutcome,
  type JobTraceContext,
  JobValidationError,
  MemoryJobStore,
  type QueueInstrument,
} from "../src/index.ts"
import type { StandardSchemaV1 } from "../src/types.ts"

const PARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
const OTHER = "00-11111111111111111111111111111111-2222222222222222-00"
const TRACE: JobTraceContext = {
  traceId: "33333333333333333333333333333333",
  spanId: "4444444444444444",
  sampled: true,
  traceparent: "00-33333333333333333333333333333333-4444444444444444-01",
}

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

const passThrough: QueueInstrument = {
  enqueue: (_info, next) => next(),
  run: (_info, next) => next(),
}

async function leasedTraceparents(store: MemoryJobStore): Promise<Array<string | undefined>> {
  return store.lease(Number.MAX_SAFE_INTEGER, 100, 1).map((job) => job.traceparent)
}

describe("traceparent on the store contract", () => {
  test("for(context) stores the context's traceparent; an option overrides it; malformed ones are dropped", async () => {
    const store = new MemoryJobStore()
    const queue = createQueue({ store, instrument: {} })
    const job = queue.define("email", { handler() {} })

    await job.for({ trace: { traceparent: PARENT } }).enqueue(undefined)
    await job.for({ trace: { traceparent: PARENT } }).enqueue(undefined, { traceparent: OTHER })
    await job.enqueue(undefined, { traceparent: OTHER })
    await job.enqueue(undefined)
    await job.for({}).enqueue(undefined)
    await job.for({ trace: "x" }).enqueue(undefined)
    await job.for({ trace: { traceparent: `${PARENT} ` } }).enqueue(undefined)
    await job.for({ trace: { traceparent: PARENT.toUpperCase() } }).enqueue(undefined)
    await job.enqueue(undefined, { traceparent: "not-a-traceparent" })
    await queue.enqueue("email", undefined, { traceparent: OTHER })

    expect(await leasedTraceparents(store)).toEqual([
      PARENT,
      OTHER,
      OTHER,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      OTHER,
    ])
  })

  test("a beacon alone also binds, announces, and stores the trace", async () => {
    const store = new MemoryJobStore()
    const seen: string[] = []
    const queue = createQueue({ store, beacon: (_context, capability) => seen.push(capability) })
    await queue
      .define("email", { handler() {} })
      .for({ trace: { traceparent: PARENT } })
      .enqueue(undefined)
    expect(seen).toEqual(["jobs.enqueue"])
    expect(await leasedTraceparents(store)).toEqual([PARENT])
  })

  test("for(context) without a beacon or an instrument throws", () => {
    const job = createQueue().define("email", { handler() {} })
    expect(() => job.for({})).toThrow(/needs a beacon or an instrument/)
  })
})

describe("instrument.enqueue", () => {
  test("next({ traceparent }) stores that context instead of the producer's and resolves to the id", async () => {
    const store = new MemoryJobStore({ idFor: () => "job-1" })
    const infos: unknown[] = []
    const queue = createQueue({
      store,
      instrument: {
        async enqueue(info, next) {
          infos.push(info)
          const id = await next({ traceparent: OTHER })
          return `ignored-${id}`
        },
      },
    })
    const job = queue.define("email", { handler() {} })
    expect(await job.for({ trace: { traceparent: PARENT } }).enqueue(undefined)).toBe("job-1")
    expect(infos).toEqual([{ name: "email", traceparent: PARENT }])
    expect(await leasedTraceparents(store)).toEqual([OTHER])
  })

  test("a malformed traceparent from the hook falls back to the producer's", async () => {
    const store = new MemoryJobStore()
    const queue = createQueue({
      store,
      instrument: { enqueue: (_info, next) => next({ traceparent: "garbage" }) },
    })
    await queue.define("email", { handler() {} }).enqueue(undefined, { traceparent: PARENT })
    expect(await leasedTraceparents(store)).toEqual([PARENT])
  })

  test("a hook that throws, skips next, or calls it twice still enqueues exactly once", async () => {
    for (const enqueue of [
      () => {
        throw new Error("instrument bug")
      },
      async () => undefined,
      async (_info: unknown, next: () => Promise<string>) => {
        await next()
        await next()
        throw new Error("after next")
      },
    ] as Array<NonNullable<QueueInstrument["enqueue"]>>) {
      const store = new MemoryJobStore()
      const queue = createQueue({ store, instrument: { enqueue } })
      await queue.define("email", { handler() {} }).enqueue(undefined, { traceparent: PARENT })
      expect(await leasedTraceparents(store)).toEqual([PARENT])
    }
  })

  test("a validation failure still rejects the caller, whatever the hook does with it", async () => {
    let seen: unknown
    const queue = createQueue({
      instrument: {
        async enqueue(_info, next) {
          try {
            return await next()
          } catch (error) {
            seen = error
            return "swallowed"
          }
        },
      },
    })
    const job = queue.define("email", { input: toSchema, handler() {} })
    await expect(job.enqueue({ to: 1 } as never)).rejects.toBeInstanceOf(JobValidationError)
    expect(seen).toBeInstanceOf(JobValidationError)
    await expect(queue.enqueue("missing", {})).rejects.toBeInstanceOf(JobError)
  })

  test("next() called after the hook returned rejects instead of writing again", async () => {
    let late: (() => Promise<string>) | undefined
    const store = new MemoryJobStore()
    const queue = createQueue({
      store,
      instrument: {
        async enqueue(_info, next) {
          late = next
          return next()
        },
      },
    })
    await queue.define("email", { handler() {} }).enqueue(undefined)
    await expect((late as () => Promise<string>)()).rejects.toThrow(/after it returned/)
    expect((await queue.counts()).pending).toBe(1)
  })
})

describe("instrument.run", () => {
  test("next({ trace }) puts the trace on JobContext and resolves to the outcome", async () => {
    const contexts: JobContext[] = []
    const outcomes: JobRunOutcome[] = []
    const infos: unknown[] = []
    let failures = 0
    const queue = createQueue({
      store: new MemoryJobStore({ idFor: () => "job-1" }),
      backoff: fixedBackoff(0),
      onError: () => undefined,
      instrument: {
        async run(info, next) {
          infos.push(info)
          const outcome = await next({ trace: TRACE })
          outcomes.push(outcome)
          return outcome
        },
      },
    })
    queue.define("flaky", {
      retries: 2,
      handler(_payload, ctx) {
        contexts.push(ctx)
        failures++
        throw new Error("boom")
      },
    })
    queue.define("ok", { handler: (_payload, ctx) => void contexts.push(ctx) })
    await queue.enqueue("flaky", undefined, { traceparent: PARENT })
    await queue.drain()
    await queue.enqueue("ok", undefined)
    await queue.drain()

    expect(failures).toBe(2)
    expect(outcomes).toEqual(["retried", "dead-lettered", "completed"])
    expect(contexts.map((ctx) => ctx.trace)).toEqual([TRACE, TRACE, TRACE])
    expect(infos[0]).toEqual({
      id: "job-1",
      name: "flaky",
      attempt: 1,
      maxAttempts: 2,
      traceparent: PARENT,
    })
    expect(infos[1]).toMatchObject({ attempt: 2, traceparent: PARENT })
    expect(infos[2]).toMatchObject({ name: "ok", attempt: 1, traceparent: undefined })
  })

  test("without an instrument, or when the hook passes no trace, JobContext has no trace", async () => {
    for (const instrument of [undefined, passThrough]) {
      const contexts: JobContext[] = []
      const queue = createQueue(instrument === undefined ? {} : { instrument })
      queue.define("ok", { handler: (_payload, ctx) => void contexts.push(ctx) })
      await queue.enqueue("ok", undefined)
      await queue.drain()
      expect(contexts).toHaveLength(1)
      expect("trace" in (contexts[0] as object)).toBe(false)
    }
  })

  test("a hook that throws, skips next, or calls it twice still runs the handler exactly once", async () => {
    for (const run of [
      () => {
        throw new Error("instrument bug")
      },
      async () => undefined,
      async (_info: unknown, next: () => Promise<JobRunOutcome>) => {
        await Promise.all([next(), next()])
        throw new Error("after next")
      },
    ] as Array<NonNullable<QueueInstrument["run"]>>) {
      let runs = 0
      const queue = createQueue({ instrument: { run } })
      queue.define("ok", {
        handler: () => {
          runs++
        },
      })
      await queue.enqueue("ok", undefined)
      await queue.drain()
      expect(runs).toBe(1)
      expect((await queue.counts()).pending).toBe(0)
    }
  })

  test("a store failure while settling the job rejects next() and the processing round", async () => {
    const store = new MemoryJobStore()
    store.complete = () => {
      throw new Error("store down")
    }
    store.retry = () => {
      throw new Error("store down")
    }
    let rejected: unknown
    const queue = createQueue({
      store,
      onError: () => undefined,
      instrument: {
        async run(_info, next) {
          try {
            return await next()
          } catch (error) {
            rejected = error
            throw error
          }
        },
      },
    })
    queue.define("ok", { handler() {} })
    await queue.enqueue("ok", undefined)
    await expect(queue.process()).rejects.toThrow("store down")
    expect((rejected as Error).message).toBe("store down")
  })

  test("next() called after the hook returned rejects instead of running again", async () => {
    let late: (() => Promise<JobRunOutcome>) | undefined
    let runs = 0
    const queue = createQueue({
      instrument: {
        async run(_info, next) {
          late = next
          return next()
        },
      },
    })
    queue.define("ok", {
      handler: () => {
        runs++
      },
    })
    await queue.enqueue("ok", undefined)
    await queue.drain()
    await expect((late as () => Promise<JobRunOutcome>)()).rejects.toThrow(/after it returned/)
    expect(runs).toBe(1)
  })

  test("a job with no handler is dead-lettered without reaching the hook", async () => {
    const store = new MemoryJobStore()
    let hooked = 0
    const producer = createQueue({ store })
    producer.define("gone", { handler() {} })
    await producer.enqueue("gone", undefined)
    const consumer = createQueue({
      store,
      instrument: {
        run: (_info, next) => {
          hooked++
          return next()
        },
      },
    })
    await consumer.drain()
    expect(hooked).toBe(0)
    expect(store.deadLetters()).toHaveLength(1)
  })
})

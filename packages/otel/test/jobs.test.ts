import { describe, expect, test } from "bun:test"
import { createCache } from "@nifrajs/cache"
import { server } from "@nifrajs/core/server"
import {
  createQueue,
  fixedBackoff,
  type JobContext,
  MemoryJobStore,
  type StandardSchemaV1,
} from "@nifrajs/jobs"
import { cacheTracing } from "../src/cache.ts"
import { jobTracing } from "../src/jobs.ts"
import type { ObservationContext } from "../src/lifecycle.ts"
import type { NifraSpan } from "../src/span.ts"
import { tracing } from "../src/tracing.ts"

function collect(): { spans: NifraSpan[]; exporter: { onEnd(span: NifraSpan): void } } {
  const spans: NifraSpan[] = []
  return { spans, exporter: { onEnd: (span) => spans.push(span) } }
}

const byName = (spans: readonly NifraSpan[], name: string): NifraSpan[] =>
  spans.filter((span) => span.name === name)

const UNSAMPLED = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00"

describe("jobTracing", () => {
  test("request -> send -> process -> cache: one trace, the process span a child of the send span", async () => {
    const { spans, exporter } = collect()
    const cache = createCache({ observer: cacheTracing({ exporter }) })
    const queue = createQueue({
      store: new MemoryJobStore({ idFor: () => "job-7" }),
      instrument: jobTracing({ exporter }),
    })
    let seen: JobContext | undefined
    const email = queue.define("email-job", {
      async handler(_payload: { to: string }, ctx) {
        seen = ctx
        await cache.for(ctx).wrap("tmpl:welcome", () => "hi")
      },
    })
    const app = server()
      .use(tracing({ exporter }))
      .post("/orders", async (c) => ({ id: await email.for(c).enqueue({ to: "a@b.example" }) }))

    const res = await app.fetch(new Request("http://nifra.test/orders", { method: "POST" }))
    expect(await res.json()).toEqual({ id: "job-7" })
    await queue.drain()

    const [request] = byName(spans, "POST /orders")
    const [send] = byName(spans, "send email-job")
    const [process] = byName(spans, "process email-job")
    const [wrap] = byName(spans, "cache wrap")
    if (!request || !send || !process || !wrap) throw new Error("missing span")

    expect(send).toMatchObject({
      kind: "producer",
      traceId: request.traceId,
      parentSpanId: request.spanId,
      status: "ok",
      attributes: {
        "messaging.system": "nifra.jobs",
        "messaging.operation.type": "send",
        "messaging.operation.name": "send",
        "messaging.destination.name": "email-job",
        "messaging.message.id": "job-7",
      },
    })
    expect(process).toMatchObject({
      kind: "consumer",
      traceId: request.traceId,
      parentSpanId: send.spanId,
      status: "ok",
      links: [{ traceId: send.traceId, spanId: send.spanId }],
      attributes: {
        "messaging.operation.type": "process",
        "messaging.operation.name": "process",
        "messaging.destination.name": "email-job",
        "messaging.message.id": "job-7",
        "nifra.job.attempt": 1,
        "nifra.job.outcome": "completed",
      },
    })
    expect(seen?.trace?.spanId).toBe(process.spanId)
    expect(wrap.parentSpanId).toBe(process.spanId)
    expect(JSON.stringify(spans)).not.toContain("a@b.example")
  })

  test("every retry is its own process span; the last one marks the dead-lettering", async () => {
    const { spans, exporter } = collect()
    const queue = createQueue({
      backoff: fixedBackoff(0),
      onError: () => undefined,
      instrument: jobTracing({ exporter }),
    })
    queue.define("flaky", {
      retries: 3,
      handler() {
        throw new Error("secret customer detail")
      },
    })
    await queue.enqueue("flaky", undefined)
    await queue.drain()

    const [send] = byName(spans, "send flaky")
    const attempts = byName(spans, "process flaky")
    expect(send?.parentSpanId).toBeUndefined()
    expect(attempts).toHaveLength(3)
    expect(attempts.map((span) => span.parentSpanId)).toEqual([
      send?.spanId,
      send?.spanId,
      send?.spanId,
    ])
    expect(attempts.map((span) => span.status)).toEqual(["error", "error", "error"])
    expect(attempts.map((span) => span.attributes["nifra.job.attempt"])).toEqual([1, 2, 3])
    expect(attempts.map((span) => span.attributes["nifra.job.outcome"])).toEqual([
      "retried",
      "retried",
      "dead-lettered",
    ])
    expect(attempts.map((span) => span.attributes["nifra.job.dead_lettered"])).toEqual([
      undefined,
      undefined,
      true,
    ])
    expect(attempts[2]?.attributes["error.type"]).toBe("_OTHER")
    expect(JSON.stringify(spans)).not.toContain("secret customer detail")
  })

  test("a malformed stored traceparent starts the process span as a new trace", async () => {
    const { spans, exporter } = collect()
    const store = new MemoryJobStore()
    const lease = store.lease.bind(store)
    store.lease = (now, limit, leaseMs) =>
      lease(now, limit, leaseMs).map((job) => ({
        ...job,
        traceparent: "00-00000000000000000000000000000000-b7ad6b7169203331-01",
      }))
    const queue = createQueue({ store, instrument: jobTracing({ exporter }) })
    queue.define("job", { handler() {} })
    await queue.enqueue("job", undefined)
    await queue.drain()
    const [send] = byName(spans, "send job")
    const [process] = byName(spans, "process job")
    expect(process?.parentSpanId).toBeUndefined()
    expect(process?.links).toBeUndefined()
    expect(process?.traceId).not.toBe(send?.traceId)
  })

  test("the sampled flag travels from the producer to the process span", async () => {
    const { spans, exporter } = collect()
    const queue = createQueue({ instrument: jobTracing({ exporter }) })
    queue.define("job", { handler() {} })
    await queue.enqueue("job", undefined, { traceparent: UNSAMPLED })
    await queue.drain()
    expect(byName(spans, "send job")[0]?.sampled).toBe(false)
    expect(byName(spans, "process job")[0]?.sampled).toBe(false)
    expect(byName(spans, "process job")[0]?.traceId).toBe("0af7651916cd43dd8448eb211c80319c")
  })

  test("an enqueue that fails validation is an error send span and still rejects", async () => {
    const { spans, exporter } = collect()
    const schema: StandardSchemaV1<{ n: number }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [{ message: "n must hold 4111111111111111" }] }),
      },
    }
    const queue = createQueue({ instrument: jobTracing({ exporter }) })
    const job = queue.define("strict", { input: schema, handler() {} })
    await expect(job.enqueue({ n: 1 })).rejects.toThrow()
    expect(byName(spans, "send strict")[0]).toMatchObject({
      status: "error",
      attributes: { "error.type": "_OTHER", "error.recorded": true },
    })
    expect(JSON.stringify(spans)).not.toContain("4111111111111111")
  })

  test("a store failure while settling ends the process span as an error", async () => {
    const { spans, exporter } = collect()
    const store = new MemoryJobStore()
    store.complete = () => {
      throw new Error("store down")
    }
    store.retry = () => {
      throw new Error("store down")
    }
    const queue = createQueue({
      store,
      onError: () => undefined,
      instrument: jobTracing({ exporter }),
    })
    queue.define("job", { handler() {} })
    await queue.enqueue("job", undefined)
    await expect(queue.process()).rejects.toThrow("store down")
    expect(byName(spans, "process job")[0]).toMatchObject({
      status: "error",
      attributes: { "error.type": "_OTHER" },
    })
  })

  test("scope runs the attempt with the process span's context", async () => {
    const { spans, exporter } = collect()
    const scoped: ObservationContext[] = []
    let inside = false
    const queue = createQueue({
      instrument: jobTracing({
        exporter,
        scope: (trace, run) => {
          scoped.push(trace)
          inside = true
          try {
            return run()
          } finally {
            inside = false
          }
        },
      }),
    })
    let ranInside = false
    queue.define("job", {
      handler() {
        ranInside = inside
      },
    })
    await queue.enqueue("job", undefined)
    await queue.drain()
    expect(ranInside).toBe(true)
    expect(scoped.map((trace) => trace.spanId)).toEqual([
      byName(spans, "process job")[0]?.spanId as string,
    ])
  })
})

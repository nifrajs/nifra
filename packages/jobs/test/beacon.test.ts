import { describe, expect, test } from "bun:test"
import { createQueue } from "../src/queue.ts"

/** See `@nifrajs/cache`'s beacon suite for the reasoning; this pins the same contract for enqueue. */
describe("jobs capability beacon", () => {
  test("announces before enqueueing, bound to the request context", async () => {
    const seen: Array<{ context: object; capability: string }> = []
    const queue = createQueue({
      beacon: (context, capability) => seen.push({ context, capability }),
    })
    const job = queue.define<{ id: number }>("index", { handler: () => undefined })
    const ctx = {}
    await job.for(ctx).enqueue({ id: 1 })
    expect(seen).toEqual([{ context: ctx, capability: "jobs.enqueue" }])
  })

  test("a refused capability rejects and the job is never queued", async () => {
    const queue = createQueue({
      beacon: () => {
        throw new Error("capability assurance: jobs.enqueue is not declared")
      },
    })
    const job = queue.define<{ id: number }>("index", { handler: () => undefined })
    await expect(job.for({}).enqueue({ id: 1 })).rejects.toThrow("not declared")
    expect((await queue.counts()).pending).toBe(0)
  })

  test("for(context) without a beacon throws rather than producing nothing", () => {
    const job = createQueue().define("index", { handler: () => undefined })
    expect(() => job.for({})).toThrow(/needs a beacon/)
  })

  test("the unbound handle is unchanged - no beacon, no cost", async () => {
    const seen: string[] = []
    const queue = createQueue({ beacon: (_c, capability) => seen.push(capability) })
    const job = queue.define<{ id: number }>("index", { handler: () => undefined })
    await job.enqueue({ id: 1 })
    expect(seen).toEqual([])
    expect((await queue.counts()).pending).toBe(1)
  })

  test("the bound handle keeps its name and token is overridable", async () => {
    const seen: string[] = []
    const queue = createQueue({
      beacon: (_c, capability) => seen.push(capability),
      capabilities: { enqueue: "work.submit" },
    })
    const job = queue.define<{ id: number }>("index", { handler: () => undefined })
    const bound = job.for({})
    expect(bound.name).toBe("index")
    await bound.enqueue({ id: 1 })
    expect(seen).toEqual(["work.submit"])
  })
})

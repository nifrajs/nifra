import { describe, expect, test } from "bun:test"
import {
  createStepCatalog,
  OrchestrationHost,
  type RunPlan,
  type StepCatalog,
} from "../src/orchestration/index.ts"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

function linearCatalog(): StepCatalog {
  return createStepCatalog({
    work: { kind: "task", run: (ctx) => ctx.set(ctx.nodeId, "done") },
  })
}

function twoLayerPlan(): RunPlan {
  return {
    version: 1,
    id: "p",
    nodes: [
      { id: "a", kind: "task", step: "work" },
      { id: "b", kind: "task", step: "work", dependsOn: ["a"] },
    ],
  }
}

describe("OrchestrationHost lifecycle", () => {
  test("submit, start, settle a happy path", async () => {
    const host = new OrchestrationHost({ catalog: linearCatalog() })
    const runId = await host.submit(twoLayerPlan())
    expect(host.inspect(runId).state).toBe("submitted")
    host.start(runId)
    const result = await host.settled(runId)
    expect(result.status).toBe("succeeded")
    expect(result.completedNodeIds).toEqual(["a", "b"])
    expect(result.counters).toEqual({ total: 4, started: 2, completed: 2, failed: 0 })
    expect(result.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.failureCode).toBeUndefined()
  })

  test("terminal digest is stable across identical runs", async () => {
    const a = new OrchestrationHost({ catalog: linearCatalog() })
    const b = new OrchestrationHost({ catalog: linearCatalog() })
    await a.submit(twoLayerPlan(), { runId: "x" })
    await b.submit(twoLayerPlan(), { runId: "x" })
    a.start("x")
    b.start("x")
    const ra = await a.settled("x")
    const rb = await b.settled("x")
    expect(ra.evidenceDigest).toBe(rb.evidenceDigest)
  })

  test("illegal transitions return a stable code and mutate nothing", async () => {
    const host = new OrchestrationHost({ catalog: linearCatalog() })
    const runId = await host.submit(twoLayerPlan())

    expect(() => host.inspect("nope")).toThrow(expect.objectContaining({ code: "E_NOT_FOUND" }))
    expect(() => host.pause(runId)).toThrow(
      expect.objectContaining({ code: "E_ILLEGAL_TRANSITION" }),
    )
    expect(() => host.resume(runId)).toThrow(
      expect.objectContaining({ code: "E_ILLEGAL_TRANSITION" }),
    )
    await expect(host.result(runId)).rejects.toThrow(
      expect.objectContaining({ code: "E_NOT_TERMINAL" }),
    )
    // None of the failed transitions moved the run off `submitted`.
    expect(host.inspect(runId).state).toBe("submitted")

    host.start(runId)
    expect(() => host.start(runId)).toThrow(
      expect.objectContaining({ code: "E_ILLEGAL_TRANSITION" }),
    )
    await host.settled(runId)
    expect(() => host.cancel(runId)).toThrow(
      expect.objectContaining({ code: "E_ILLEGAL_TRANSITION" }),
    )
  })

  test("safe pause holds at a layer boundary and resume finishes the run", async () => {
    const gate = deferred()
    const catalog = createStepCatalog({
      slow: { kind: "task", run: () => gate.promise },
      fast: { kind: "task", run: (ctx) => ctx.set(ctx.nodeId, "done") },
    })
    const host = new OrchestrationHost({ catalog })
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [
        { id: "a", kind: "task", step: "slow" },
        { id: "b", kind: "task", step: "fast", dependsOn: ["a"] },
      ],
    }
    const runId = await host.submit(plan)
    host.start(runId)
    expect(host.inspect(runId).state).toBe("running")
    host.pause(runId)
    expect(host.inspect(runId).state).toBe("paused")
    gate.resolve() // layer 0 (in-flight) may finish; layer 1 must not start while paused
    await tick()
    const paused = host.inspect(runId)
    expect(paused.state).toBe("paused")
    expect(paused.counters.completed).toBe(1) // only `a`
    host.resume(runId)
    const result = await host.settled(runId)
    expect(result.status).toBe("succeeded")
    expect(result.completedNodeIds).toEqual(["a", "b"])
  })

  test("cancel reaches active work and a late completion cannot revive the run", async () => {
    const catalog = createStepCatalog({
      blocks: {
        kind: "task",
        run: (ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          }),
      },
    })
    const host = new OrchestrationHost({ catalog })
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [{ id: "a", kind: "task", step: "blocks" }],
    }
    const runId = await host.submit(plan)
    host.start(runId)
    expect(host.inspect(runId).state).toBe("running")
    host.cancel(runId)
    const result = await host.settled(runId)
    expect(result.status).toBe("cancelled")
    expect(result.failureCode).toBe("E_CANCELLED")
    expect(result.completedNodeIds).toEqual([])
    await tick() // any late settling of the aborted layer
    expect(host.inspect(runId).state).toBe("cancelled")
    expect(host.inspect(runId).counters.completed).toBe(0)
  })

  test("a failing gate ends the run failed with a stable code", async () => {
    const catalog = createStepCatalog({
      seed: { kind: "task", run: () => undefined },
      gate: { kind: "verify", run: () => false },
    })
    const host = new OrchestrationHost({ catalog })
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [
        { id: "seed", kind: "task", step: "seed" },
        { id: "check", kind: "verify", step: "gate", dependsOn: ["seed"] },
      ],
    }
    const runId = await host.submit(plan)
    host.start(runId)
    const result = await host.settled(runId)
    expect(result.status).toBe("failed")
    expect(result.failureCode).toBe("E_GATE_REJECTED")
    expect(result.completedNodeIds).toEqual(["seed"])
  })

  test("an over-limit plan fails closed at submit with no run registered", async () => {
    const host = new OrchestrationHost({ catalog: linearCatalog(), limits: { maxNodes: 1 } })
    await expect(host.submit(twoLayerPlan(), { runId: "big" })).rejects.toThrow(
      expect.objectContaining({ code: "E_MAX_NODES" }),
    )
    expect(() => host.inspect("big")).toThrow(expect.objectContaining({ code: "E_NOT_FOUND" }))
  })

  test("a duplicate run id is rejected", async () => {
    const host = new OrchestrationHost({ catalog: linearCatalog() })
    await host.submit(twoLayerPlan(), { runId: "dup" })
    await expect(host.submit(twoLayerPlan(), { runId: "dup" })).rejects.toThrow(
      expect.objectContaining({ code: "E_DUPLICATE_RUN" }),
    )
  })
})

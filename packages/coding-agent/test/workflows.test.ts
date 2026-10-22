import { describe, expect, test } from "bun:test"
import { PlanRunner } from "../src/plans.ts"
import { BoundedSubagentRunner } from "../src/subagents.ts"
import { WorkflowRunner, type WorkflowStep } from "../src/workflows.ts"

describe("bounded workflows", () => {
  test("runs a sequence with verification and retry", async () => {
    let attempts = 0
    const events: string[] = []
    const workflow: WorkflowStep = {
      type: "sequence",
      steps: [
        { type: "task", id: "plan", run: ({ set }) => set("planned", true) },
        {
          type: "retry",
          attempts: 2,
          step: {
            type: "task",
            id: "repair",
            run: () => {
              if (++attempts < 2) throw new Error("retry")
            },
          },
        },
        { type: "verify", id: "verify", run: ({ values }) => values.get("planned") === true },
      ],
    }
    const result = await new WorkflowRunner({
      onEvent: (event) => {
        events.push(event.type)
      },
    }).run(workflow)
    expect(result.ok).toBe(true)
    expect(attempts).toBe(2)
    expect(events).toContain("step.completed")
  })

  test("caps child fan-out", async () => {
    const runner = new BoundedSubagentRunner(
      { run: async ({ spec }) => spec.role },
      { maxChildren: 2 },
    )
    const results = await runner.runMany([
      { id: "one", role: "planner", prompt: "one" },
      { id: "two", role: "reviewer", prompt: "two" },
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    const denied = await runner.run({ id: "three", role: "reviewer", prompt: "three" })
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain("limit")
  })

  test("a refused spec takes no child slot", async () => {
    const children = { started: 0 }
    const runner = new BoundedSubagentRunner(
      { run: async ({ spec }) => spec.role },
      {
        maxChildren: 1,
        children,
        allowedCapabilities: ["read"],
        workspace: { root: process.cwd() },
      },
    )
    const refused = await Promise.all([
      runner.run({ id: "Bad id", role: "worker", prompt: "x" }),
      runner.run({ id: "empty", role: "worker", prompt: "" }),
      runner.run({ id: "slow", role: "worker", prompt: "x", timeoutMs: 0 }),
      runner.run({ id: "writes", role: "worker", prompt: "x", capabilities: ["write"] }),
      runner.run({ id: "outside", role: "worker", prompt: "x", cwd: "/" }),
    ])
    expect(refused.map((result) => result.ok)).toEqual([false, false, false, false, false])
    expect(children.started).toBe(0)
    expect(await runner.run({ id: "valid", role: "worker", prompt: "x" })).toMatchObject({
      ok: true,
    })
    expect(children.started).toBe(1)
  })

  test("a timeout covers workspace acquisition, and a late lease is released unused", async () => {
    const lease = Promise.withResolvers<{ cwd: string; cleanup: () => void }>()
    let ran = false
    let released = 0
    const children = { started: 0 }
    const runner = new BoundedSubagentRunner(
      {
        run: () => {
          ran = true
          return "ran"
        },
      },
      {
        maxChildren: 1,
        children,
        workspace: { root: process.cwd(), isolatedWorktree: () => lease.promise },
      },
    )
    const result = await runner.run({ id: "slow", role: "worker", prompt: "x", timeoutMs: 10 })
    expect(result).toMatchObject({ ok: false, error: "subagent timed out" })
    // The acquisition is still running, so it still holds its slot.
    expect(children.started).toBe(1)
    const cleanedUp = Promise.withResolvers<void>()
    lease.resolve({
      cwd: process.cwd(),
      cleanup: () => {
        released++
        cleanedUp.resolve()
      },
    })
    await cleanedUp.promise
    expect(released).toBe(1)
    expect(ran).toBe(false)
    expect(await runner.run({ id: "next", role: "worker", prompt: "x" })).toMatchObject({
      ok: true,
    })
    expect(children.started).toBe(1)
  })

  test("a child whose executor never starts gives its slot back", async () => {
    const children = { started: 0 }
    let lease = (): Promise<{ cwd: string }> => Promise.reject(new Error("no worktree"))
    const runner = new BoundedSubagentRunner(
      { run: async ({ spec }) => spec.role },
      {
        maxChildren: 1,
        children,
        workspace: { root: process.cwd(), isolatedWorktree: () => lease() },
      },
    )
    expect(await runner.run({ id: "failed", role: "worker", prompt: "x" })).toMatchObject({
      ok: false,
      error: "no worktree",
    })
    expect(children.started).toBe(0)
    lease = async () => ({ cwd: "/" })
    expect(await runner.run({ id: "outside", role: "worker", prompt: "x" })).toMatchObject({
      ok: false,
      error: "isolated worktree escapes workspace policy",
    })
    expect(children.started).toBe(0)
    lease = async () => ({ cwd: process.cwd() })
    expect(await runner.run({ id: "valid", role: "worker", prompt: "x" })).toMatchObject({
      ok: true,
    })
    expect(children.started).toBe(1)
  })

  test("a lease that fails after the timeout is dropped without an unhandled rejection", async () => {
    const lease = Promise.withResolvers<{ cwd: string }>()
    let ran = false
    const runner = new BoundedSubagentRunner(
      {
        run: () => {
          ran = true
          return "ran"
        },
      },
      { workspace: { root: process.cwd(), isolatedWorktree: () => lease.promise } },
    )
    const result = await runner.run({ id: "failing", role: "worker", prompt: "x", timeoutMs: 10 })
    expect(result).toMatchObject({ ok: false, error: "subagent timed out" })
    lease.reject(new Error("no worktree"))
    await lease.promise.catch(() => {})
    await Promise.resolve()
    expect(ran).toBe(false)
  })

  test("supports bounded conditional branches and plan phases", async () => {
    const planEvents: string[] = []
    const plan = await new PlanRunner({
      onEvent: (event) => {
        planEvents.push(event.type)
      },
    }).run({
      id: "ship",
      goal: "verify the change",
      phases: [
        {
          id: "gate",
          title: "gate",
          step: {
            type: "branch",
            id: "choose",
            when: () => true,
            // biome-ignore lint/suspicious/noThenProperty: `then` is part of the public branch step contract.
            then: { type: "task", id: "yes", run: ({ set }) => set("selected", "yes") },
            otherwise: { type: "task", id: "no", run: ({ set }) => set("selected", "no") },
          },
        },
      ],
    })
    expect(plan.ok).toBe(true)
    expect(planEvents).toContain("plan.phase.completed")
    expect(planEvents.at(-1)).toBe("plan.completed")
  })

  test("propagates nested context depth and fails at the configured ceiling", async () => {
    const nested: WorkflowStep = {
      type: "task",
      id: "nested",
      run: ({ run }) => run({ type: "task", id: "too-deep", run: () => "never" }),
    }
    const result = await new WorkflowRunner({ maxDepth: 1, maxSteps: 16 }).run({
      type: "task",
      id: "root",
      run: ({ run }) => run(nested),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("max depth")
  })

  test("removes retry abort listeners after the delay settles", async () => {
    const listeners = new Set<EventListener>()
    const signal = {
      aborted: false,
      addEventListener(_type: string, listener: EventListener) {
        listeners.add(listener)
      },
      removeEventListener(_type: string, listener: EventListener) {
        listeners.delete(listener)
      },
    } as unknown as AbortSignal
    let attempts = 0
    const result = await new WorkflowRunner({ signal }).run({
      type: "retry",
      attempts: 2,
      backoffMs: 1,
      step: {
        type: "task",
        id: "flaky",
        run: () => {
          if (++attempts === 1) throw new Error("retry once")
          return "ok"
        },
      },
    })
    expect(result.ok).toBe(true)
    expect(listeners.size).toBe(0)
  })

  test("allows an empty parallel step without manufacturing a concurrency error", async () => {
    const result = await new WorkflowRunner().run({ type: "parallel", steps: [] })
    expect(result).toMatchObject({ ok: true })
  })

  test("a failed parallel step starts no further step and waits for the running ones", async () => {
    const ran: string[] = []
    const task = (id: string, ms: number, fail = false) => ({
      type: "task" as const,
      id,
      run: async () => {
        await Bun.sleep(ms)
        if (fail) throw new Error("boom")
        ran.push(id)
      },
    })
    const result = await new WorkflowRunner().run({
      type: "parallel",
      maxConcurrency: 2,
      steps: [
        task("fails", 5, true),
        task("running", 30),
        task("queued-a", 1),
        task("queued-b", 1),
      ],
    })
    expect(result).toMatchObject({ ok: false, error: "boom" })
    expect(ran).toEqual(["running"])
    await Bun.sleep(50)
    expect(ran).toEqual(["running"])
  })
})

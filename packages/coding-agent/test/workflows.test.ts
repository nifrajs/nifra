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
})

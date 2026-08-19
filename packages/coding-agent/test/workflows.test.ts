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
})

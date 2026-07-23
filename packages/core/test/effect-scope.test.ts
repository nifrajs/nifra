import { describe, expect, test } from "bun:test"
import { createEffectScope } from "../src/effect-scope.ts"

describe("owned effect scope", () => {
  test("correlates durable transitions, evidence, and telemetry around one effect", async () => {
    const transitions: string[] = []
    const phases: string[] = []
    const scope = createEffectScope({
      observers: [(event) => phases.push(`${event.stage}:${event.phase}`)],
    })

    const result = await scope.run<{ effectId: string; charged: boolean }>(
      {
        capability: "payments.charge",
        target: "provider:stripe",
        transitions: {
          intent: ({ effectId }) => {
            transitions.push(`intent:${effectId}`)
          },
          executing: ({ effectId }) => {
            transitions.push(`executing:${effectId}`)
          },
          committed: ({ effectId }) => {
            transitions.push(`committed:${effectId}`)
          },
        },
      },
      async ({ effectId }) => ({ effectId, charged: true }),
    )

    expect(result.charged).toBe(true)
    expect(transitions).toEqual([
      `intent:${result.effectId}`,
      `executing:${result.effectId}`,
      `committed:${result.effectId}`,
    ])
    expect(phases).toEqual(["execution:started", "execution:succeeded"])
    expect(scope.evidence()).toEqual({ began: true, committed: true, ambiguous: false })
  })
})

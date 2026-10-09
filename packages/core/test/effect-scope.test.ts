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

  test("an error code that is not a string is refused, not stringified into a token", async () => {
    const scope = createEffectScope()
    await expect(
      scope.run(
        // An `any`-typed mapper (here parsed JSON) can hand back null; "null" is a valid code shape.
        { capability: "payments.charge", errorCode: () => JSON.parse("null") },
        async () => {
          throw new Error("provider down")
        },
      ),
    ).rejects.toThrow("effect errorCode is invalid")
  })

  test("a misconfigured error code still settles the effect as failed", async () => {
    for (const misconfigured of [
      { errorCode: () => JSON.parse("null"), thrown: "effect errorCode is invalid" },
      {
        errorCode: () => {
          throw new Error("mapper broke")
        },
        thrown: "mapper broke",
      },
    ]) {
      const failed: string[] = []
      const phases: string[] = []
      const scope = createEffectScope({ observers: [(event) => phases.push(event.phase)] })
      await expect(
        scope.run(
          {
            capability: "payments.charge",
            errorCode: misconfigured.errorCode,
            transitions: {
              failed: (_context, { began, errorCode }) => {
                failed.push(`${began}:${errorCode}`)
              },
            },
          },
          async () => {
            throw new Error("provider down")
          },
        ),
      ).rejects.toThrow(misconfigured.thrown)
      expect(failed).toEqual(["true:execution_failed"])
      expect(phases).toEqual(["started", "ambiguous"])
    }
  })

  test("manual evidence preserves retry safety and terminal certainty", () => {
    const scope = createEffectScope()
    scope.markSafeToRetry()
    expect(scope.safeToRetry()).toBe(true)

    scope.markBegan()
    expect(scope.safeToRetry()).toBe(false)
    expect(scope.evidence()).toEqual({ began: true, committed: false, ambiguous: true })
    expect(() => scope.markSafeToRetry()).toThrow("after an effect began")

    scope.markFailed()
    expect(scope.evidence()).toEqual({ began: true, committed: false, ambiguous: false })
    scope.markAmbiguous()
    expect(scope.evidence().ambiguous).toBe(true)
    scope.markCommitted()
    expect(scope.evidence()).toEqual({ began: true, committed: true, ambiguous: false })
  })
})

import { describe, expect, test } from "bun:test"
import { defineFaultProfile, referenceFaultProfile, runFaultProfile } from "../src/fault-profile.ts"

describe("fault profiles", () => {
  test("runs the reference profile through the deterministic lab", async () => {
    const result = await runFaultProfile(referenceFaultProfile, { seed: 17 })
    expect(result.ok).toBe(true)
    expect(result.scenarios).toHaveLength(1)
    expect(result.scenarios[0]?.replay.seed).toBe(17)
  })

  test("rejects duplicate scenario ids", () => {
    expect(() =>
      defineFaultProfile({
        name: "duplicate",
        scenarios: [
          {
            id: "same",
            name: "same-one",
            description: "one",
            execute: () => {},
            verify: () => true,
          },
          {
            id: "same",
            name: "same-two",
            description: "two",
            execute: () => {},
            verify: () => true,
          },
        ],
      }),
    ).toThrow("duplicate scenario id")
  })
})

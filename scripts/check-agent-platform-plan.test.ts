import { describe, expect, test } from "bun:test"
import { auditAgentPlatformPlan } from "./check-agent-platform-plan.ts"

describe("agent-platform plan gate", () => {
  test("owns every planned requirement exactly once", () => {
    const report = auditAgentPlatformPlan()
    expect(report.ok).toBe(true)
    expect(report.taskCount).toBe(24)
    expect(report.requirementCount).toBe(88)
    expect(report.owners).toBe(88)
  })
})

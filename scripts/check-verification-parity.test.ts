import { describe, expect, test } from "bun:test"
import { verificationPlan } from "../packages/cli/src/verification-plan.ts"
import { checkVerificationParity, extractWorkflowCommands } from "./check-verification-parity.ts"

describe("verification-plan / CI parity", () => {
  test("extracts executable Bun scripts, including chained commands, not comments or filters", () => {
    expect(
      extractWorkflowCommands(`
# bun run check:docs is only an example in this comment
run: bun run build && bun run check:docs
run: bun run --filter '@nifrajs/core' build
run: bun test packages/cli/test --randomize
`),
    ).toEqual(["run build", "run check:docs", "test packages/cli/test --randomize"])
  })

  test("reports a missing required gate and an unplanned check command", () => {
    const commands = verificationPlan("release")
      .filter((gate) => gate.workflowRequired && gate.id !== "publish")
      .flatMap((gate) => gate.commands.map((args) => `bun ${args.join(" ")}`))
      .join("\n")
    const report = checkVerificationParity(`${commands}\nbun run check:llms`)

    expect(report.ok).toBe(false)
    expect(report.missing).toEqual([{ gateId: "publish", command: "run check:publish" }])
    expect(report.unexpected).toEqual(["run check:llms"])
    expect(report.missing.some((entry) => entry.gateId === "core-performance")).toBe(false)
  })
})

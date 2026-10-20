import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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

  test("the live workflow keeps every gate reachable after splitting its checks", () => {
    const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
    expect(checkVerificationParity(source).ok).toBe(true)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: checked-in workflow; absent fields fail the assertions below
    const workflow = Bun.YAML.parse(source) as CheckWorkflow
    const groups = workflow.jobs.checks?.strategy?.matrix?.group ?? []
    const steps = workflow.jobs.checks?.steps ?? []
    expect(groups.length).toBeGreaterThan(1)
    expect(new Set(groups).size).toBe(groups.length)
    expect(workflow.jobs.checks?.strategy?.["fail-fast"]).toBe(false)
    expect(steps.some((step) => step.run === "bun run build" && step.if === undefined)).toBe(true)
    for (const step of steps) {
      if (step.if === undefined) continue
      const group = step.if.match(/^matrix\.group == '([^']+)'$/)?.[1]
      expect(groups).toContain(group ?? "")
    }
    for (const group of groups) {
      expect(
        steps.some((step) => step.if === `matrix.group == '${group}'` && step.run !== undefined),
      ).toBe(true)
    }
    expect(workflow.jobs.check?.needs).toBe("checks")
    expect(workflow.jobs.check?.if).toContain("!cancelled()")
  })

  test("the required check rejects failed, cancelled, and skipped matrix results", () => {
    const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: checked-in workflow; absent fields fail the assertions below
    const workflow = Bun.YAML.parse(source) as CheckWorkflow
    const gate = workflow.jobs.check?.steps?.find((step) => step.env?.RESULT !== undefined)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    expect(gate?.env?.RESULT).toBe("${{ needs.checks.result }}")
    if (gate?.run === undefined) throw new Error("missing aggregate check command")
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      const proc = Bun.spawnSync(["bash", "-c", gate.run], { env: { ...Bun.env, RESULT: result } })
      expect(proc.exitCode === 0).toBe(result === "success")
    }
  })
})

interface CheckWorkflow {
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly needs?: string
        readonly if?: string
        readonly strategy?: {
          readonly "fail-fast"?: boolean
          readonly matrix?: { readonly group?: readonly string[] }
        }
        readonly steps?: readonly {
          readonly if?: string
          readonly run?: string
          readonly env?: Readonly<Record<string, string>>
        }[]
      }
    >
  >
}

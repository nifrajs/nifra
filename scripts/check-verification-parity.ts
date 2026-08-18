import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  type VerificationGateSpec,
  verificationPlan,
} from "../packages/cli/src/verification-plan.ts"

export interface VerificationParityMissing {
  readonly gateId: string
  readonly command: string
}

export interface VerificationParityReport {
  readonly ok: boolean
  readonly workflowCommands: readonly string[]
  readonly missing: readonly VerificationParityMissing[]
  readonly unexpected: readonly string[]
}

const commandKey = (args: readonly string[]): string => args.join(" ")

const knownWorkflowCommand = (script: string): boolean =>
  script === "build" ||
  script === "lint" ||
  script === "test" ||
  script === "typecheck" ||
  script.startsWith("check:") ||
  script.startsWith("test:")

/** Extract direct `bun run <script>` invocations from workflow shell lines. */
export function extractWorkflowCommands(workflow: string): readonly string[] {
  const found: string[] = []
  for (const line of workflow.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    for (const segment of line.split(/&&|\|\||;/)) {
      const match = segment.match(/\bbun\s+run\s+([^\s&#;|]+)/)
      const script = match?.[1]
      if (script !== undefined && knownWorkflowCommand(script)) {
        const key = `run ${script}`
        if (!found.includes(key)) found.push(key)
        continue
      }
      const directTest = segment.match(/\bbun\s+test\b([^#;|]*)/)
      if (directTest !== null) {
        const key = `test${directTest[1].trim() === "" ? "" : ` ${directTest[1].trim()}`}`
        if (!found.includes(key)) found.push(key)
      }
    }
  }
  return found
}

const plannedCommands = (gates: readonly VerificationGateSpec[]): ReadonlySet<string> =>
  new Set(gates.flatMap((gate) => gate.commands.map(commandKey)))

/** Compare the release plan with the commands represented in a GitHub Actions workflow. */
export function checkVerificationParity(workflow: string): VerificationParityReport {
  const gates = verificationPlan("release")
  const workflowCommands = extractWorkflowCommands(workflow)
  const present = new Set(workflowCommands)
  const missing = gates.flatMap((gate) =>
    gate.workflowRequired
      ? gate.commands
          .filter((args) => !present.has(commandKey(args)))
          .map((args) => ({ gateId: gate.id, command: commandKey(args) }))
      : [],
  )
  const known = plannedCommands(gates)
  const unexpected = workflowCommands.filter((command) => !known.has(command))
  return {
    ok: missing.length === 0 && unexpected.length === 0,
    workflowCommands,
    missing,
    unexpected,
  }
}

export function renderVerificationParity(report: VerificationParityReport): string {
  const lines = ["nifra verification-plan / CI parity"]
  if (report.missing.length > 0) {
    lines.push("", "missing required workflow gates:")
    for (const entry of report.missing) lines.push(`- ${entry.gateId}: bun ${entry.command}`)
  }
  if (report.unexpected.length > 0) {
    lines.push("", "workflow commands not represented by the release plan:")
    for (const command of report.unexpected) lines.push(`- bun ${command}`)
  }
  if (report.ok) lines.push("", "✓ workflow matches the release verification plan")
  else lines.push("", "✗ workflow does not match the release verification plan")
  return lines.join("\n")
}

if (import.meta.main) {
  const workflowPath = resolve(process.cwd(), ".github/workflows/ci.yml")
  const report = checkVerificationParity(readFileSync(workflowPath, "utf8"))
  console.log(renderVerificationParity(report))
  if (!report.ok) process.exitCode = 1
}

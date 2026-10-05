/**
 * The repository release verification gate.
 *
 * This module is intentionally independent from app loading. The root package scripts and the
 * `nifra verify` command both call this runner, so the local and CI paths share one gate plan.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import {
  omittedVerificationGateIds,
  type VerificationGateSpec,
  type VerificationPlanMode,
  verificationPlan,
} from "./verification-plan.ts"

export type ReleaseVerificationMode = VerificationPlanMode
/** `undeclared`: the project's package.json has no script for the gate, so it was not run. */
export type ReleaseGateStatus = "pass" | "fail" | "skipped" | "undeclared"

export interface ReleaseGateResult {
  readonly id: string
  readonly status: ReleaseGateStatus
  readonly commands: readonly string[]
  readonly exitCode?: number
  readonly message?: string
  /** The last lines a failed gate's command printed, so a CI log shows why it failed. */
  readonly output?: string
  readonly remediation: string
}

export interface ReleaseVerificationResult {
  readonly ok: boolean
  readonly mode: ReleaseVerificationMode
  readonly gates: readonly ReleaseGateResult[]
  /** Release gates intentionally absent from the selected shorter plan. */
  readonly omittedReleaseGateIds: readonly string[]
  /** Gates a shared runner left out; a local verification runs them. */
  readonly localGateIds: readonly string[]
}

export interface ReleaseCommandResult {
  readonly exitCode: number
  readonly stdout?: string
  readonly stderr?: string
}

export interface ReleaseCommandSpec {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string | undefined>
}

export interface ReleaseVerificationOptions {
  readonly mode?: ReleaseVerificationMode
  /**
   * Leave out the gates the plan keeps off CI (`workflowRequired: false`): timing on a shared
   * runner swings too far run to run to gate a release on.
   */
  readonly sharedRunner?: boolean
  readonly runCommand?: (spec: ReleaseCommandSpec) => Promise<ReleaseCommandResult>
}

const runBunCommand = async (spec: ReleaseCommandSpec): Promise<ReleaseCommandResult> => {
  const child = Bun.spawn([process.execPath, ...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

const OUTPUT_TAIL_LINES = 40

/** The last lines a command printed, stdout before stderr, or undefined when it printed nothing. */
const outputTail = (result: ReleaseCommandResult): string | undefined => {
  const printed = [result.stdout, result.stderr]
    .map((text) => text?.trimEnd() ?? "")
    .filter((text) => text !== "")
  return printed.length === 0
    ? undefined
    : printed.join("\n").split("\n").slice(-OUTPUT_TAIL_LINES).join("\n")
}

const parsePackage = (path: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const workspacePatterns = (pkg: Record<string, unknown>): readonly string[] => {
  const workspaces = pkg.workspaces
  if (Array.isArray(workspaces))
    return workspaces.filter((item): item is string => typeof item === "string")
  if (workspaces !== null && typeof workspaces === "object") {
    const packages = (workspaces as Record<string, unknown>).packages
    if (Array.isArray(packages))
      return packages.filter((item): item is string => typeof item === "string")
  }
  return []
}

const workspaceContains = async (
  root: string,
  patterns: readonly string[],
  target: string,
): Promise<boolean> => {
  if (root === target) return patterns.length > 0
  for (const pattern of patterns) {
    const packagePattern = `${pattern.replace(/\/$/, "")}/package.json`
    for await (const match of new Bun.Glob(packagePattern).scan({ cwd: root, dot: false })) {
      if (match.split(/[\\/]/).includes("node_modules")) continue
      const packageRoot = resolve(root, dirname(match))
      const targetRelative = relative(packageRoot, target)
      if (
        targetRelative === "" ||
        (!targetRelative.startsWith(`..${sep}`) && targetRelative !== "..")
      )
        return true
    }
  }
  return false
}

/** Resolve the repository root even when the command starts in a workspace package. */
export async function resolveVerificationRoot(start: string): Promise<string> {
  const original = realpathSync(resolve(start))
  let current = original
  for (;;) {
    const pkgPath = join(current, "package.json")
    const pkg = parsePackage(pkgPath)
    if (pkg !== undefined && (await workspaceContains(current, workspacePatterns(pkg), original))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return original
    current = parent
  }
}

const gatePlan = (mode: ReleaseVerificationMode): readonly VerificationGateSpec[] =>
  verificationPlan(mode)

const commandLabel = (args: readonly string[]): string => `bun ${args.join(" ")}`

const runGate = async (
  root: string,
  gate: VerificationGateSpec,
  runCommand: (spec: ReleaseCommandSpec) => Promise<ReleaseCommandResult>,
  fixtureRoot: string,
): Promise<ReleaseGateResult> => {
  let lastExitCode: number | undefined
  for (const [index, args] of gate.commands.entries()) {
    const fixture = mkdtempSync(join(fixtureRoot, `${gate.id}-${index}-`))
    const result = await runCommand({
      args,
      cwd: root,
      env: {
        ...process.env,
        TMPDIR: fixture,
        NIFRA_VERIFY_GATE: gate.id,
      },
    })
    lastExitCode = result.exitCode
    if (result.exitCode !== 0) {
      const failed: Omit<ReleaseGateResult, "output"> & { output?: string } = {
        id: gate.id,
        status: "fail",
        commands: gate.commands.map(commandLabel),
        exitCode: result.exitCode,
        message: `${commandLabel(args)} exited with code ${result.exitCode}`,
        remediation: gate.remediation,
      }
      const output = outputTail(result)
      if (output !== undefined) failed.output = output
      return failed
    }
  }
  return {
    id: gate.id,
    status: "pass",
    commands: gate.commands.map(commandLabel),
    ...(lastExitCode === undefined ? {} : { exitCode: lastExitCode }),
    remediation: gate.remediation,
  }
}

const skippedGate = (gate: VerificationGateSpec, failedId: string): ReleaseGateResult => ({
  id: gate.id,
  status: "skipped",
  commands: gate.commands.map(commandLabel),
  message: `not run because the ${failedId} gate failed`,
  remediation: `Fix the ${failedId} gate first, then rerun verification.`,
})

const undeclaredGate = (gate: VerificationGateSpec, script: string): ReleaseGateResult => ({
  id: gate.id,
  status: "undeclared",
  commands: gate.commands.map(commandLabel),
  message: `\`${script}\` is not a script in package.json`,
  remediation: `Declare a \`${script}\` script to run this gate.`,
})

/** The first `bun run <script>` of a gate that the root package.json does not declare. */
const undeclaredScript = (
  gate: VerificationGateSpec,
  scripts: ReadonlySet<string>,
): string | undefined =>
  gate.commands.find(
    ([verb, script]) => verb === "run" && script !== undefined && !scripts.has(script),
  )?.[1]

/** Collect the same gate result rendered by the CLI and used by repository scripts. */
export async function collectReleaseVerification(
  start: string,
  options: ReleaseVerificationOptions = {},
): Promise<ReleaseVerificationResult> {
  const mode = options.mode ?? "default"
  const root = await resolveVerificationRoot(start)
  const runCommand = options.runCommand ?? runBunCommand
  const fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), "nifra-verify-"))
  const declared = parsePackage(join(root, "package.json"))?.scripts
  const scripts = new Set(
    declared !== null && typeof declared === "object" ? Object.keys(declared) : [],
  )
  const plan = gatePlan(mode)
  const local = options.sharedRunner === true ? plan.filter((gate) => !gate.workflowRequired) : []
  const gates: ReleaseGateResult[] = []
  try {
    let failedId: string | undefined
    for (const gate of plan) {
      if (local.includes(gate)) continue
      if (failedId !== undefined) {
        gates.push(skippedGate(gate, failedId))
        continue
      }
      // The plan names the nifra repository's own scripts; a project without one has nothing to run.
      const missing = undeclaredScript(gate, scripts)
      if (missing !== undefined) {
        gates.push(undeclaredGate(gate, missing))
        continue
      }
      const result = await runGate(root, gate, runCommand, fixtureRoot)
      gates.push(result)
      if (result.status === "fail") failedId = result.id
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
  return {
    ok:
      gates.some((gate) => gate.status === "pass") &&
      gates.every((gate) => gate.status === "pass" || gate.status === "undeclared"),
    mode,
    gates,
    omittedReleaseGateIds: omittedVerificationGateIds(mode),
    localGateIds: local.map((gate) => gate.id),
  }
}

export function renderReleaseVerification(result: ReleaseVerificationResult): string {
  const lines = [`nifra verify --${result.mode}`, ""]
  for (const gate of result.gates) {
    const marker = gate.status === "pass" ? "✓" : gate.status === "fail" ? "✗" : "-"
    lines.push(`${marker} ${gate.id}: ${gate.status}`)
    if (gate.message !== undefined) lines.push(`  ${gate.message}`)
    if (gate.output !== undefined)
      lines.push(...gate.output.split("\n").map((line) => `  | ${line}`))
    if (gate.status === "fail" || gate.status === "skipped")
      lines.push(`  fix: ${gate.remediation}`)
  }
  if (result.omittedReleaseGateIds.length > 0) {
    lines.push(
      "",
      `note: default verification omits release gates: ${result.omittedReleaseGateIds.join(", ")}`,
      "      run `bun run check:release` for the full release gate.",
    )
  }
  if (result.localGateIds.length > 0) {
    lines.push(
      "",
      `note: a shared runner leaves out the timing gates: ${result.localGateIds.join(", ")}`,
      "      run `bun run check:release` locally for them.",
    )
  }
  lines.push("", result.ok ? "✓ verification passed" : "✗ verification failed")
  return lines.join("\n")
}

/** Run verification and render either the human or machine interface. */
export async function runReleaseVerification(
  cwd: string,
  options: ReleaseVerificationOptions & { readonly json?: boolean } = {},
): Promise<boolean> {
  const result = await collectReleaseVerification(cwd, options)
  if (options.json) console.log(JSON.stringify(result, null, 2))
  else console.log(renderReleaseVerification(result))
  return result.ok
}

if (import.meta.main) {
  const mode: ReleaseVerificationMode = process.argv.includes("--release") ? "release" : "default"
  const ok = await runReleaseVerification(process.cwd(), {
    mode,
    sharedRunner: process.argv.includes("--shared-runner"),
    json: process.argv.includes("--json"),
  })
  if (!ok) process.exitCode = 1
}

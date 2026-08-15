/**
 * The repository release verification gate.
 *
 * This module is intentionally independent from app loading. The root package scripts and the
 * `nifra verify` command both call this runner, so the local and CI paths share one gate plan.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

export type ReleaseVerificationMode = "default" | "release"
export type ReleaseGateStatus = "pass" | "fail" | "skipped"

export interface ReleaseGateResult {
  readonly id: string
  readonly status: ReleaseGateStatus
  readonly commands: readonly string[]
  readonly exitCode?: number
  readonly message?: string
  readonly remediation: string
}

export interface ReleaseVerificationResult {
  readonly ok: boolean
  readonly mode: ReleaseVerificationMode
  readonly gates: readonly ReleaseGateResult[]
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
  readonly runCommand?: (spec: ReleaseCommandSpec) => Promise<ReleaseCommandResult>
}

interface ReleaseGateSpec {
  readonly id: string
  readonly commands: readonly (readonly string[])[]
  readonly remediation: string
}

const DEFAULT_GATES: readonly ReleaseGateSpec[] = [
  {
    id: "lint",
    commands: [["run", "lint"]],
    remediation: "Run `bun run lint` and fix the reported lint findings.",
  },
  {
    id: "typecheck",
    commands: [["run", "typecheck"]],
    remediation: "Run `bun run typecheck` and fix the reported TypeScript errors.",
  },
  {
    id: "tests",
    commands: [["run", "test"]],
    remediation: "Run `bun run test` and fix the first failing test.",
  },
  {
    id: "docs",
    commands: [["run", "check:docs"]],
    remediation: "Run `bun run check:docs` and update the failing documentation example.",
  },
  {
    id: "api-corpus",
    commands: [["run", "check:api"]],
    remediation: "Run `bun run gen:api` and review the generated API reference.",
  },
  {
    id: "cards-corpus",
    commands: [["run", "check:cards"]],
    remediation: "Run `bun run gen:cards` and review the generated package cards.",
  },
  {
    id: "node-outcome-corpus",
    commands: [["run", "check:node-outcome"]],
    remediation: "Run `bun run gen:node-outcome` and review the generated Node outcome contract.",
  },
  {
    id: "sitemap",
    commands: [["run", "check:sitemap"]],
    remediation: "Run `bun run gen:sitemap` and review the generated sitemap.",
  },
  {
    id: "public-boundary",
    commands: [["run", "check:public-boundary"]],
    remediation:
      "Run `bun run check:public-boundary` and remove the reported public-boundary violation.",
  },
  {
    id: "size",
    commands: [["run", "check:size"]],
    remediation:
      "Run `bun run check:size` and either reduce the bundle or update the reviewed budget.",
  },
  // Appended, not inserted: RELEASE_GATES below composes this list BY INDEX
  // (`slice(0, 3)`, `[3]`), so a gate added in the middle would silently re-point those.
  {
    id: "changesets",
    commands: [["run", "check:changesets"]],
    remediation:
      "Run `bun run changeset` and name every package whose source changed, so the release documents it.",
  },
]

const RELEASE_GATES: readonly ReleaseGateSpec[] = [
  {
    id: "build",
    commands: [["run", "build"]],
    remediation: "Run `bun run build` and fix the first package build failure.",
  },
  ...DEFAULT_GATES.slice(0, 3),
  {
    id: "coverage",
    commands: [
      ["run", "test:coverage"],
      ["run", "check:coverage"],
    ],
    remediation:
      "Run `bun run test:coverage` first, then `bun run check:coverage`, and fix the reported coverage regression.",
  },
  {
    id: "corpus",
    commands: [["run", "check:corpus"]],
    remediation:
      "Run `bun run gen:llms`, `bun run gen:api`, and `bun run gen:cards`, then rerun the corpus gate.",
  },
  DEFAULT_GATES[3] as ReleaseGateSpec,
  {
    id: "public-boundary",
    commands: [["run", "check:public-boundary"]],
    remediation:
      "Run `bun run check:public-boundary` and remove the reported public-boundary violation.",
  },
  {
    id: "size",
    commands: [["run", "check:size"]],
    remediation:
      "Run `bun run check:size` and either reduce the bundle or update the reviewed budget.",
  },
  {
    id: "core-performance",
    commands: [["run", "check:core-performance"]],
    remediation:
      "Run `bun run check:core-performance` and investigate the measured performance regression.",
  },
  {
    id: "publish",
    commands: [["run", "check:publish"]],
    remediation:
      "Run `bun run check:publish` and fix the publish-consumer metadata or type-surface failure.",
  },
  {
    id: "consumer",
    commands: [["run", "check:consumers"]],
    remediation: "Run `bun run check:consumers` and fix the isolated consumer failure.",
  },
  {
    id: "cold-start",
    commands: [["run", "check:cold-start"]],
    remediation:
      "Run `bun run check:cold-start` and fix the fresh scaffold install or build failure.",
  },
  {
    id: "cross-runtime-deno",
    commands: [
      ["run", "test:deno"],
      ["run", "check:deno-tarball"],
    ],
    remediation:
      "Run `bun run test:deno` and `bun run check:deno-tarball`, then fix the first Deno compatibility failure.",
  },
  {
    id: "cross-runtime-node",
    commands: [["run", "test:node"]],
    remediation: "Run `bun run test:node` and fix the Node runtime adapter failure.",
  },
  {
    id: "pipeline-parity",
    commands: [["run", "check:pipeline-parity"]],
    remediation:
      "Run `bun run check:pipeline-parity` and fix the development and production manifest drift.",
  },
  // Last in release mode on purpose: this is the gate on what the release SAYS, and it is the only
  // one whose failure is invisible afterwards - a shipped version cannot grow the changelog line it
  // never had.
  {
    id: "changesets",
    commands: [["run", "check:changesets"]],
    remediation:
      "Run `bun run changeset` and name every package whose source changed, so the release documents it.",
  },
]

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

const gatePlan = (mode: ReleaseVerificationMode): readonly ReleaseGateSpec[] =>
  mode === "release" ? RELEASE_GATES : DEFAULT_GATES

const commandLabel = (args: readonly string[]): string => `bun ${args.join(" ")}`

const runGate = async (
  root: string,
  gate: ReleaseGateSpec,
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
      return {
        id: gate.id,
        status: "fail",
        commands: gate.commands.map(commandLabel),
        exitCode: result.exitCode,
        message: `${commandLabel(args)} exited with code ${result.exitCode}`,
        remediation: gate.remediation,
      }
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

const skippedGate = (gate: ReleaseGateSpec, failedId: string): ReleaseGateResult => ({
  id: gate.id,
  status: "skipped",
  commands: gate.commands.map(commandLabel),
  message: `not run because the ${failedId} gate failed`,
  remediation: `Fix the ${failedId} gate first, then rerun verification.`,
})

/** Collect the same gate result rendered by the CLI and used by repository scripts. */
export async function collectReleaseVerification(
  start: string,
  options: ReleaseVerificationOptions = {},
): Promise<ReleaseVerificationResult> {
  const mode = options.mode ?? "default"
  const root = await resolveVerificationRoot(start)
  const runCommand = options.runCommand ?? runBunCommand
  const fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), "nifra-verify-"))
  const gates: ReleaseGateResult[] = []
  try {
    let failedId: string | undefined
    for (const gate of gatePlan(mode)) {
      if (failedId !== undefined) {
        gates.push(skippedGate(gate, failedId))
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
    ok: gates.every((gate) => gate.status === "pass"),
    mode,
    gates,
  }
}

export function renderReleaseVerification(result: ReleaseVerificationResult): string {
  const lines = [`nifra verify --${result.mode}`, ""]
  for (const gate of result.gates) {
    const marker = gate.status === "pass" ? "✓" : gate.status === "fail" ? "✗" : "-"
    lines.push(`${marker} ${gate.id}: ${gate.status}`)
    if (gate.message !== undefined) lines.push(`  ${gate.message}`)
    if (gate.status !== "pass") lines.push(`  fix: ${gate.remediation}`)
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
    json: process.argv.includes("--json"),
  })
  if (!ok) process.exitCode = 1
}

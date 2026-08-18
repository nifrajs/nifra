/**
 * The repository verification plan.
 *
 * Gates are declared once and plans refer to them by stable id. Keeping composition separate from the
 * gate registry is deliberate: adding a gate to one mode cannot silently re-point another mode through
 * an array index. The release runner, its CLI/MCP projections, and the plan tests all consume this seam.
 */

export type VerificationPlanMode = "default" | "release"

export interface VerificationGateSpec {
  readonly id: string
  readonly commands: readonly (readonly string[])[]
  readonly remediation: string
  /** Whether the gate must be represented by a command in `.github/workflows/ci.yml`. */
  readonly workflowRequired: boolean
}

const gate = (
  id: string,
  commands: readonly (readonly string[])[],
  remediation: string,
  options: { readonly workflowRequired?: boolean } = {},
): VerificationGateSpec =>
  Object.freeze({
    id,
    commands: Object.freeze(commands.map((args) => Object.freeze([...args]))),
    remediation,
    workflowRequired: options.workflowRequired ?? true,
  })

const GATES = Object.freeze([
  gate("lint", [["run", "lint"]], "Run `bun run lint` and fix the reported lint findings."),
  gate(
    "typecheck",
    [["run", "typecheck"]],
    "Run `bun run typecheck` and fix the reported TypeScript errors.",
  ),
  gate("tests", [["run", "test"]], "Run `bun run test` and fix the first failing test."),
  gate(
    "docs",
    [["run", "check:docs"]],
    "Run `bun run check:docs` and update the failing documentation example.",
  ),
  gate(
    "api-corpus",
    [["run", "check:api"]],
    "Run `bun run gen:api` and review the generated API reference.",
  ),
  gate(
    "cards-corpus",
    [["run", "check:cards"]],
    "Run `bun run gen:cards` and review the generated package cards.",
  ),
  gate(
    "node-outcome-corpus",
    [["run", "check:node-outcome"]],
    "Run `bun run gen:node-outcome` and review the generated Node outcome contract.",
  ),
  gate(
    "sitemap",
    [["run", "check:sitemap"]],
    "Run `bun run gen:sitemap` and review the generated sitemap.",
  ),
  gate(
    "public-manifest",
    [["run", "check:public-manifest"]],
    "Run `bun run gen:public` and review the generated public product manifest.",
  ),
  gate(
    "public-boundary",
    [["run", "check:public-boundary"]],
    "Run `bun run check:public-boundary` and remove the reported public-boundary violation.",
  ),
  gate(
    "size",
    [["run", "check:size"]],
    "Run `bun run check:size` and either reduce the bundle or update the reviewed budget.",
  ),
  gate(
    "changesets",
    [["run", "check:changesets"]],
    "Run `bun run changeset` and name every package whose source changed, so the release documents it.",
  ),
  gate("build", [["run", "build"]], "Run `bun run build` and fix the first package build failure."),
  gate(
    "coverage",
    [
      ["run", "test:coverage"],
      ["run", "check:coverage"],
    ],
    "Run `bun run test:coverage` first, then `bun run check:coverage`, and fix the reported coverage regression.",
  ),
  gate(
    "corpus",
    [["run", "check:corpus"]],
    "Run `bun run gen:llms`, `bun run gen:api`, and `bun run gen:cards`, then rerun the corpus gate.",
  ),
  gate(
    "core-performance",
    [["run", "check:core-performance"]],
    "Run `bun run check:core-performance` and investigate the measured performance regression.",
    { workflowRequired: false },
  ),
  gate(
    "publish",
    [["run", "check:publish"]],
    "Run `bun run check:publish` and fix the publish-consumer metadata or type-surface failure.",
  ),
  gate(
    "consumer",
    [["run", "check:consumers"]],
    "Run `bun run check:consumers` and fix the isolated consumer failure.",
  ),
  gate(
    "cold-start",
    [["run", "check:cold-start"]],
    "Run `bun run check:cold-start` and fix the fresh scaffold install or build failure.",
  ),
  gate(
    "cross-runtime-deno",
    [
      ["run", "test:deno"],
      ["run", "check:deno-tarball"],
    ],
    "Run `bun run test:deno` and `bun run check:deno-tarball`, then fix the first Deno compatibility failure.",
  ),
  gate(
    "cross-runtime-node",
    [["run", "test:node"]],
    "Run `bun run test:node` and fix the Node runtime adapter failure.",
  ),
  gate(
    "workerd",
    [["run", "check:workerd"]],
    "Run `bun run check:workerd` and fix the real Workers runtime contract failure.",
  ),
  gate(
    "pipeline-parity",
    [["run", "check:pipeline-parity"]],
    "Run `bun run check:pipeline-parity` and fix the development and production manifest drift.",
  ),
  gate(
    "cli-isolation",
    [["run", "check:cli-isolation"]],
    "Run `bun run check:cli-isolation` and fix the first order-dependent CLI test failure.",
  ),
  gate(
    "verification-parity",
    [["run", "check:verification-parity"]],
    "Run `bun run check:verification-parity` and reconcile the release plan with CI.",
  ),
])

const DEFAULT_PLAN = Object.freeze([
  "lint",
  "typecheck",
  "tests",
  "docs",
  "api-corpus",
  "cards-corpus",
  "node-outcome-corpus",
  "sitemap",
  "public-boundary",
  "public-manifest",
  "size",
  "changesets",
] as const)

const RELEASE_PLAN = Object.freeze([
  "build",
  "lint",
  "typecheck",
  "tests",
  "cli-isolation",
  "coverage",
  "corpus",
  "docs",
  "public-boundary",
  "public-manifest",
  "size",
  "core-performance",
  "publish",
  "consumer",
  "cold-start",
  "cross-runtime-deno",
  "cross-runtime-node",
  "workerd",
  "pipeline-parity",
  "verification-parity",
  "changesets",
] as const)

const gateById = new Map(GATES.map((entry) => [entry.id, entry]))

const planIds = (mode: VerificationPlanMode): readonly string[] =>
  mode === "release" ? RELEASE_PLAN : DEFAULT_PLAN

/** Return the immutable, ordered gate plan for a verification mode. */
export function verificationPlan(
  mode: VerificationPlanMode = "default",
): readonly VerificationGateSpec[] {
  return Object.freeze(
    planIds(mode).map((id) => {
      const entry = gateById.get(id)
      if (entry === undefined) throw new Error(`verification plan references unknown gate: ${id}`)
      return entry
    }),
  )
}

/** Stable IDs are useful to CI and tests that need to compare plans without parsing prose. */
export function verificationPlanIds(mode: VerificationPlanMode = "default"): readonly string[] {
  return planIds(mode)
}

/** Stable IDs in the full plan that are not part of a shorter plan. */
export function omittedVerificationGateIds(
  mode: VerificationPlanMode = "default",
  fullMode: VerificationPlanMode = "release",
): readonly string[] {
  const included = new Set(planIds(mode))
  return Object.freeze(planIds(fullMode).filter((id) => !included.has(id)))
}

const commandLabel = (args: readonly string[]): string => `bun ${args.join(" ")}`

/** Render the declarative plan without running any gate. */
export function renderVerificationPlan(mode: VerificationPlanMode = "default"): string {
  const lines = [`nifra verification plan --${mode}`, ""]
  for (const [index, entry] of verificationPlan(mode).entries()) {
    lines.push(`${index + 1}. ${entry.id}: ${entry.commands.map(commandLabel).join(" → ")}`)
  }
  return lines.join("\n")
}

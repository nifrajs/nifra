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
    "rest-tests",
    [["run", "test:rest"]],
    "Run `bun run test:rest` and fix the first failing test.",
  ),
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
    "site",
    [["run", "check:site"]],
    "Run `bun run check:site` and fix what the site's production build refuses; the release deploys that build after npm has the packages.",
  ),
  gate(
    "public-manifest",
    [["run", "check:public-manifest"]],
    "Run `bun run gen:public` and review the generated public product manifest.",
  ),
  gate(
    "public-boundary",
    [["run", "check:public-boundary"]],
    "Run `bun run check:public-boundary` (which includes the agent-boundary scan) and remove the reported boundary violation.",
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
    "middleware-performance",
    [["run", "check:middleware-overhead"]],
    "Run `bun run check:middleware-overhead` and investigate the middleware-chain regression.",
    { workflowRequired: false },
  ),
  gate(
    "output-guard-performance",
    [["run", "check:output-guard"]],
    "Run `bun run check:output-guard` and investigate the data guard's projection cost.",
    { workflowRequired: false },
  ),
  gate(
    "edge-startup",
    [["run", "check:edge-startup"]],
    "Run `bun run check:edge-startup` and investigate edge/Workers import-time growth.",
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
    "runtime-differential",
    [["run", "check:runtime-differential"]],
    "Run `bun run check:runtime-differential` and replay the printed shrunk case; fix the runtime or adapter that answered differently, or document the difference in scripts/runtime-differential/oracle.ts.",
  ),
  gate(
    "pipeline-parity",
    [["run", "check:pipeline-parity"]],
    "Run `bun run check:pipeline-parity` and fix the development and production manifest drift.",
  ),
  gate(
    "leak-matrix",
    [["run", "check:leak-matrix"]],
    "Run `bun run check:leak-matrix` and fix the pipeline that let server code or a credential through.",
  ),
  gate(
    "cli-isolation",
    [["run", "check:cli-isolation"]],
    "Run `bun run check:cli-isolation` and fix the first order-dependent CLI test failure.",
  ),
  gate(
    "plugin-manifest",
    [["run", "check:plugin"]],
    "Run `bun run check:plugin` and reconcile the skills package, plugin, and marketplace manifests.",
  ),
  gate(
    "verification-parity",
    [["run", "check:verification-parity"]],
    "Run `bun run check:verification-parity` and reconcile the release plan with CI.",
  ),
  gate(
    "server-components-contracts",
    [["run", "check:server-components:contracts"]],
    "Run `bun run check:server-components:contracts` and fix the component admission, transport or lifecycle regression.",
  ),
  gate(
    "server-components",
    [
      ["run", "check:server-components"],
      ["run", "check:server-components:consumers"],
    ],
    "Run the server-components matrix and packaged-consumer commands; every adapter and required row must pass.",
  ),
  gate(
    "server-components-performance",
    [["run", "check:server-components:performance"]],
    "Run the five-run component performance comparison and investigate the measured regression.",
    { workflowRequired: false },
  ),
])

const DEFAULT_PLAN = Object.freeze([
  "lint",
  "typecheck",
  "tests",
  "server-components-contracts",
  "docs",
  "api-corpus",
  "cards-corpus",
  "node-outcome-corpus",
  "sitemap",
  "public-boundary",
  "public-manifest",
  "plugin-manifest",
  "size",
  "changesets",
] as const)

// `coverage` fails on any failing test, so it is the release plan's run of the library suites;
// `rest-tests` runs the suites it leaves out, and `tests` would only repeat the two.
const RELEASE_PLAN = Object.freeze([
  "build",
  "lint",
  "typecheck",
  "coverage",
  "rest-tests",
  "cli-isolation",
  "corpus",
  "sitemap",
  "site",
  "docs",
  "public-boundary",
  "public-manifest",
  "plugin-manifest",
  "size",
  "core-performance",
  "middleware-performance",
  "output-guard-performance",
  "edge-startup",
  "publish",
  "consumer",
  "cold-start",
  "cross-runtime-deno",
  "cross-runtime-node",
  "workerd",
  "runtime-differential",
  "pipeline-parity",
  "leak-matrix",
  "verification-parity",
  "server-components",
  "server-components-performance",
  "server-components-contracts",
  "changesets",
] as const)

/**
 * The release plan as groups CI runs in parallel jobs. Each job starts from a clean checkout, so every
 * group begins with `build`; every other release gate belongs to exactly one group.
 */
const RELEASE_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  core: [
    "build",
    "lint",
    "typecheck",
    "coverage",
    "rest-tests",
    "cli-isolation",
    "verification-parity",
    "changesets",
  ],
  artifacts: [
    "build",
    "corpus",
    "sitemap",
    "site",
    "docs",
    "public-boundary",
    "public-manifest",
    "plugin-manifest",
    "size",
    "core-performance",
    "middleware-performance",
    "output-guard-performance",
    "edge-startup",
  ],
  packages: ["build", "publish", "consumer", "cold-start"],
  runtimes: [
    "build",
    "cross-runtime-deno",
    "cross-runtime-node",
    "workerd",
    "runtime-differential",
  ],
  pipelines: ["build", "pipeline-parity", "leak-matrix"],
  "server-components": [
    "build",
    "server-components",
    "server-components-performance",
    "server-components-contracts",
  ],
})

/** The names of the release plan's CI groups. */
export function releaseGroupNames(): readonly string[] {
  return Object.keys(RELEASE_GROUPS)
}

/** The release gates one CI group runs, or undefined for a name that is not a group. */
export function releaseGroupGateIds(name: string): readonly string[] | undefined {
  return Object.hasOwn(RELEASE_GROUPS, name) ? RELEASE_GROUPS[name] : undefined
}

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

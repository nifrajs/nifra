/**
 * A gate that cannot fail looks exactly like a healthy repo. Every `check:*`, `verify*` and coverage
 * script either names the test that drives it red, or says why it has none. A new gate fails here
 * until someone decides which; a test that moves or a gate that goes away fails until the entry is
 * updated. Every CI job that runs steps also carries a timeout, so a gate that hangs fails instead of
 * holding a runner for the platform's six-hour default.
 */
import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..", "..")

type Gate = { readonly redPath: string } | { readonly untested: string }

const END_TO_END =
  "an end-to-end run against built or packed artifacts in a real runtime; its red path is a scenario inside it failing"
const COMPOSITE = "runs other gates, each listed here"
const BENCHMARK = "a measured threshold; its red path is the benchmark exceeding it"

const GATES: Readonly<Record<string, Gate>> = {
  "check:anti-slop": { redPath: "scripts/check-anti-slop.test.ts" },
  "check:publish": { redPath: "packages/create-nifra/test/version-sync.test.ts" },
  "check:public-boundary": { redPath: "scripts/check-public-boundary.test.ts" },
  "check:public-boundary:release": { redPath: "scripts/check-public-boundary-release.test.ts" },
  "check:agent-boundary": { redPath: "scripts/agent-boundary.test.ts" },
  "check:agent-isolation": { redPath: "scripts/agent-boundary.test.ts" },
  "check:workbench-agent": { untested: BENCHMARK },
  "check:deno-tarball": { untested: END_TO_END },
  "check:consumers": { untested: END_TO_END },
  "check:server-components": { untested: END_TO_END },
  "check:server-components:contracts": { untested: END_TO_END },
  "check:server-components:types": {
    untested:
      "typechecks the component fixtures with tsc; its red path is a fixture that does not compile",
  },
  "check:server-components:performance": { untested: BENCHMARK },
  "check:server-components:consumers": { untested: END_TO_END },
  "check:workerd": { untested: END_TO_END },
  "check:core-performance": { untested: BENCHMARK },
  "check:middleware-overhead": { untested: BENCHMARK },
  "check:output-guard": { untested: BENCHMARK },
  "check:edge-startup": { untested: BENCHMARK },
  "check:cold-start": { redPath: "scripts/scaffold-pins.test.ts" },
  "check:size": { untested: BENCHMARK },
  "check:pipeline-parity": { redPath: "scripts/check-pipeline-parity.test.ts" },
  "check:leak-matrix": { untested: "the gate is a test run; each matrix row asserts its own leak" },
  "check:cli-isolation": { untested: "the gate is a randomized test run" },
  "check:verification-parity": { redPath: "scripts/check-verification-parity.test.ts" },
  "check:changesets": { redPath: "scripts/check-changeset-coverage.test.ts" },
  "check:docs": { redPath: "scripts/check-doc-samples.test.ts" },
  "check:api": { redPath: "scripts/gen-api-reference.test.ts" },
  "check:cards": { redPath: "scripts/gen-llm-cards.test.ts" },
  "check:llms": { redPath: "scripts/llms-corpus-check.test.ts" },
  "check:node-outcome": { redPath: "scripts/gen-node-outcome.test.ts" },
  "check:sitemap": { redPath: "scripts/gen-sitemap.test.ts" },
  "check:corpus": { untested: COMPOSITE },
  "check:public-manifest": { redPath: "scripts/gen-public-product-manifest.test.ts" },
  "check:plugin": { redPath: "scripts/check-plugin-manifest.test.ts" },
  "check:openai-plugin": { redPath: "scripts/check-openai-plugin.test.ts" },
  verify: { redPath: "packages/cli/test/check.test.ts" },
  "verify:release": { redPath: "scripts/release-branch.test.ts" },
  "check:release": { untested: COMPOSITE },
  "check:release-tree": { redPath: "scripts/check-release-tree.test.ts" },
  check: { untested: COMPOSITE },
  "test:coverage": { redPath: "scripts/test-coverage.test.ts" },
  "check:coverage": { redPath: "scripts/coverage-ratchet.test.ts" },
}

const isGate = (name: string): boolean =>
  name === "check" || /^(check|verify)(:|$)/.test(name) || name === "test:coverage"

test("every gate names the test that drives it red, or why it has none", () => {
  const manifest: { scripts: Record<string, string> } = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  )
  const scripts = manifest.scripts
  const gates = Object.keys(scripts).filter(isGate)
  const unlisted = gates.filter((name) => GATES[name] === undefined)
  const gone = Object.keys(GATES).filter((name) => scripts[name] === undefined)
  const missingTests = Object.entries(GATES)
    .filter(([, gate]) => "redPath" in gate && !existsSync(join(ROOT, gate.redPath)))
    .map(([name]) => name)
  expect({ unlisted, gone, missingTests }).toEqual({ unlisted: [], gone: [], missingTests: [] })
})

test("every CI job that runs steps has a timeout", () => {
  const unbounded: string[] = []
  const workflows = readdirSync(join(ROOT, ".github", "workflows")).filter((name) =>
    /\.ya?ml$/.test(name),
  )
  expect(workflows).toContain("ci.yml")
  for (const workflow of workflows) {
    const parsed: unknown = Bun.YAML.parse(
      readFileSync(join(ROOT, ".github", "workflows", workflow), "utf8"),
    )
    const jobs =
      typeof parsed === "object" && parsed !== null && "jobs" in parsed ? parsed.jobs : undefined
    if (typeof jobs !== "object" || jobs === null) throw new Error(`${workflow} has no jobs`)
    for (const [name, job] of Object.entries(jobs)) {
      // A job that calls a reusable workflow cannot set its own timeout; the callee does.
      if (typeof job !== "object" || job === null || !("steps" in job)) continue
      const minutes = "timeout-minutes" in job ? job["timeout-minutes"] : undefined
      if (typeof minutes !== "number" || minutes <= 0) unbounded.push(`${workflow}: ${name}`)
    }
  }
  expect(unbounded).toEqual([])
})

// A gitignored copy of the repo (an audit snapshot, a scratch clone) carries its own root biome.json;
// without the ignore file, lint walks into it and fails on a config the commit does not contain.
test("lint skips what git ignores", () => {
  const config = JSON.parse(readFileSync(join(ROOT, "biome.json"), "utf8"))
  expect(config.vcs).toEqual({ enabled: true, clientKind: "git", useIgnoreFile: true })
})

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  changedPublicPackageVersions,
  isReleaseBranch,
  pendingChangesetFiles,
  releaseCheckBaseRef,
} from "./release-branch.ts"

describe("release branch policy", () => {
  test("accepts bounded release branch names only", () => {
    expect(isReleaseBranch("release/2026-09-29")).toBe(true)
    expect(isReleaseBranch("release/v3.6.0")).toBe(true)
    expect(isReleaseBranch("main")).toBe(false)
    expect(isReleaseBranch("release/")).toBe(false)
    expect(isReleaseBranch("release/../main")).toBe(false)
  })

  test("identifies pending changesets without treating README as a release entry", () => {
    expect(pendingChangesetFiles(["README.md", "config.json", "zeta.md", "alpha.md"])).toEqual([
      "alpha.md",
      "zeta.md",
    ])
  })

  test("requires a changed version on a public package", () => {
    const base = [
      { name: "@nifrajs/core", version: "3.5.0" },
      { name: "private-tool", version: "3.5.0", private: true },
    ]
    expect(
      changedPublicPackageVersions(base, [
        { name: "@nifrajs/core", version: "3.5.1" },
        { name: "private-tool", version: "3.5.1", private: true },
      ]),
    ).toEqual([{ name: "@nifrajs/core", baseVersion: "3.5.0", releaseVersion: "3.5.1" }])
  })

  test("requires the associated pull request base SHA for merge checks", () => {
    const baseSha = "a".repeat(40)
    expect(releaseCheckBaseRef(true, baseSha, "ignored")).toBe(baseSha)
    expect(() => releaseCheckBaseRef(true, undefined, "ignored")).toThrow(
      "RELEASE_BASE_SHA to be a full commit SHA",
    )
    expect(() => releaseCheckBaseRef(true, "main", "ignored")).toThrow(
      "RELEASE_BASE_SHA to be a full commit SHA",
    )
    expect(releaseCheckBaseRef(false, undefined, "base-sha")).toBe("base-sha")
  })
})

test("release workflow verifies release PRs and never invokes Version Packages automation", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  )
  expect(workflow).toContain("startsWith(github.event.pull_request.head.ref, 'release/')")
  expect(workflow).toContain("github.event_name != 'pull_request' && 'publish'")
  expect(workflow).toContain("queue: max")
  expect(workflow).toContain('.name == "release-verification"')
  expect(workflow).toContain("bun run release:check")
  expect(workflow).toContain("bun run changeset:publish")
  expect(workflow).not.toContain("changesets/action@")
})

test("release verification provisions the runtimes its gates run and leaves timing to the local run", () => {
  const read = (name: string): string =>
    readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")
  const release = read("release.yml")
  const job = release.slice(
    release.indexOf("\n  verify-release-pr:"),
    release.indexOf("\n  prove-release:"),
  )
  const ci = read("ci.yml")
  expect(job).toContain("bun run verify:release --shared-runner")
  for (const pin of [
    /denoland\/setup-deno@\w+\s+with:\s+deno-version: \S+/,
    /actions\/setup-node@\w+\s+with:\s+node-version: \S+/,
  ]) {
    expect(job.match(pin)?.[0]).toBe(ci.match(pin)?.[0] ?? "missing from ci.yml")
  }
})

interface WorkflowStep {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly with?: Readonly<Record<string, unknown>>
  readonly env?: Readonly<Record<string, unknown>>
}

interface WorkflowJob {
  readonly if?: string
  readonly needs?: string
  readonly environment?: unknown
  readonly permissions?: Readonly<Record<string, string>>
  readonly steps?: readonly WorkflowStep[]
}

const workflowText = (name: string): string =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")

const workflowJobs = (name: string): Readonly<Record<string, WorkflowJob | undefined>> =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a checked-in workflow; a field it lacks reads undefined and fails the assertion on it
  (Bun.YAML.parse(workflowText(name)) as { jobs: Record<string, WorkflowJob> }).jobs

const setupNode = (job: WorkflowJob | undefined): WorkflowStep | undefined =>
  job?.steps?.find((step) => step.uses?.startsWith("actions/setup-node@"))

const NPM_GATE = "Check npm can publish through trusted publishing"

test("npm publishes through trusted publishing, and only a proven release holds that identity", () => {
  expect(workflowText("release.yml")).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/)
  const jobs = workflowJobs("release.yml")
  const { publish } = jobs
  expect(publish?.needs).toBe("prove-release")
  expect(publish?.if).toBe("needs.prove-release.outputs.is_release == 'true'")
  expect(publish?.environment).toBe("npm-publish")
  expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" })
  for (const [id, job] of Object.entries(jobs)) {
    if (id === "publish") continue
    expect({ id, environment: job?.environment, idToken: job?.permissions?.["id-token"] }).toEqual({
      id,
      environment: undefined,
      idToken: undefined,
    })
  }
  const node = setupNode(publish)
  const ciNode = Object.values(workflowJobs("ci.yml")).map(setupNode).find(Boolean)
  expect(node?.uses).toBe(ciNode?.uses ?? "missing from ci.yml")
  expect(node?.with?.["node-version"]).toBe(ciNode?.with?.["node-version"])
  expect(node?.with?.["registry-url"]).toBe("https://registry.npmjs.org")
  const names = publish?.steps?.map((step) => step.name) ?? []
  expect(names.indexOf(NPM_GATE)).toBeGreaterThan(names.indexOf(node?.name))
  expect(names.indexOf(NPM_GATE)).toBeLessThan(names.indexOf("Publish versioned packages"))
})

test.skipIf(process.platform === "win32")(
  "the publish stops before it runs an npm too old for trusted publishing",
  () => {
    const gate =
      workflowJobs("release.yml").publish?.steps?.find((step) => step.name === NPM_GATE)?.run ?? ""
    expect(gate).not.toBe("")
    const dir = mkdtempSync(join(tmpdir(), "release-npm-gate-"))
    try {
      const npm = join(dir, "npm")
      const outcomes = ["10.9.2", "11.5.0", "11.5.1", "11.12.0", "12.0.0"].map((version) => {
        writeFileSync(npm, `#!/bin/sh\necho ${version}\n`)
        chmodSync(npm, 0o755)
        const run = Bun.spawnSync(["bash", "-c", gate], {
          env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
        })
        return `${version} ${run.exitCode === 0 ? "publishes" : "stops"}`
      })
      expect(outcomes).toEqual([
        "10.9.2 stops",
        "11.5.0 stops",
        "11.5.1 publishes",
        "11.12.0 publishes",
        "12.0.0 publishes",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test("a failed publish is retried from main for a merged release SHA, under the same proofs", () => {
  const release = workflowText("release.yml")
  expect(release).toContain("  workflow_dispatch:\n    inputs:\n      merge_sha:")
  const { "prove-release": prove, publish } = workflowJobs("release.yml")
  expect(prove?.if).toContain(
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
  )
  const proof = prove?.steps?.find((step) => step.name === "Prove this is a merged release PR")?.run
  for (const check of [
    `compare/\${MERGE_SHA}...main`,
    '(.path | split("@")[0]) == ".github/workflows/ci.yml" and .conclusion == "success"',
    '.name == "release-verification"',
  ])
    expect(proof).toContain(check)
  const merge = `\${{ needs.prove-release.outputs.merge_sha }}`
  const steps = publish?.steps ?? []
  expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.ref).toBe(merge)
  expect(
    steps.find((step) => step.run === "bun run release:check --merge")?.env?.RELEASE_HEAD_SHA,
  ).toBe(merge)
  // Every later step reads the validated SHA, not the trigger's.
  expect(release.match(/workflow_run\.head_sha/g)).toHaveLength(1)
})

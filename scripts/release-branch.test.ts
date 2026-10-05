import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

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
    release.indexOf("\n  publish:"),
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

const publishJob = (): string => {
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  return release.slice(release.indexOf("\n  publish:"))
}

test("the publish job logs npm in from NPM_TOKEN before it publishes, without writing the token", () => {
  const job = publishJob()
  const login = job.indexOf(
    `echo '//registry.npmjs.org/:_authToken=\${NPM_TOKEN}' > "$HOME/.npmrc"`,
  )
  expect(login).toBeGreaterThan(-1)
  expect(login).toBeLessThan(job.indexOf("run: bun run changeset:publish"))
})

test("a failed publish is retried from main for a merged release SHA, under the same proofs", () => {
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  expect(release).toContain("  workflow_dispatch:\n    inputs:\n      merge_sha:")
  const job = publishJob()
  expect(job).toContain(
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
  )
  for (const proof of [
    `compare/\${MERGE_SHA}...main`,
    '(.path | split("@")[0]) == ".github/workflows/ci.yml" and .conclusion == "success"',
    '.name == "release-verification"',
    `ref: \${{ steps.release.outputs.merge_sha }}`,
    `RELEASE_HEAD_SHA: \${{ steps.release.outputs.merge_sha }}`,
  ])
    expect(job).toContain(proof)
  // Every later step reads the validated SHA, not the trigger's.
  expect(job.match(/workflow_run\.head_sha/g)).toHaveLength(1)
})

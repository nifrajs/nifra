import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  declaredPackages,
  publishedPackages,
  uncoveredPackages,
} from "./check-changeset-coverage.ts"

/**
 * The gate's own gate. Its failure mode is the one it exists to catch: a check that never fails looks
 * exactly like a repository that never forgets a changeset.
 */

const fixture = async (): Promise<string> => await mkdtemp(join(tmpdir(), "changeset-coverage-"))

describe("declaredPackages", () => {
  test("reads every package named in a frontmatter block, quoted or bare", async () => {
    const root = await fixture()
    await mkdir(join(root, ".changeset"), { recursive: true })
    await writeFile(
      join(root, ".changeset", "one.md"),
      '---\n"@nifrajs/core": minor\n"@nifrajs/web": patch\n---\n\nSomething changed.\n',
    )
    await writeFile(
      join(root, ".changeset", "two.md"),
      "---\n@nifrajs/client: major\n---\n\nSomething else changed.\n",
    )
    // The template README ships in .changeset and has no frontmatter - it must not be parsed.
    await writeFile(join(root, ".changeset", "README.md"), "# Changesets\n")

    expect([...declaredPackages(root)].sort()).toEqual([
      "@nifrajs/client",
      "@nifrajs/core",
      "@nifrajs/web",
    ])
  })

  test("a package named only in the prose body does not count as declared", async () => {
    // The body is where the release note lives, so it mentions package names constantly. Counting one
    // would let a changeset "cover" a package it never bumps, which is the exact hole being closed.
    const root = await fixture()
    await mkdir(join(root, ".changeset"), { recursive: true })
    await writeFile(
      join(root, ".changeset", "prose.md"),
      '---\n"@nifrajs/core": minor\n---\n\nAlso affects @nifrajs/client: patch behaviour downstream.\n',
    )
    expect([...declaredPackages(root)]).toEqual(["@nifrajs/core"])
  })
})

describe("publishedPackages", () => {
  test("skips a private package and one with no name", async () => {
    const root = await fixture()
    for (const [dir, manifest] of [
      ["core", { name: "@nifrajs/core" }],
      ["skills", { name: "@nifrajs/skills", private: true }],
      ["nameless", { version: "1.0.0" }],
    ] as const) {
      await mkdir(join(root, "packages", dir), { recursive: true })
      await writeFile(join(root, "packages", dir, "package.json"), JSON.stringify(manifest))
    }
    const packages = publishedPackages(root)
    expect([...packages.keys()]).toEqual(["core"])
    expect(packages.get("core")?.name).toBe("@nifrajs/core")
  })
})

describe("uncoveredPackages", () => {
  const packages = new Map([
    ["core", { dir: "core", name: "@nifrajs/core" }],
    ["client", { dir: "client", name: "@nifrajs/client" }],
  ])

  test("reports a package whose src changed with no changeset naming it", () => {
    const uncovered = uncoveredPackages(
      ["packages/client/src/treaty.ts", "packages/core/src/index.ts"],
      packages,
      new Set(["@nifrajs/core"]),
    )
    expect([...uncovered.keys()]).toEqual(["@nifrajs/client"])
    expect(uncovered.get("@nifrajs/client")).toEqual(["packages/client/src/treaty.ts"])
  })

  test("only src ships - tests, docs, and configuration are not release-note material", () => {
    expect(
      uncoveredPackages(
        [
          "packages/client/test/treaty.test.ts",
          "packages/client/README.md",
          "packages/client/package.json",
          "packages/client/src-notes.md",
          "bench/http/run.ts",
        ],
        packages,
        new Set(),
      ).size,
    ).toBe(0)
  })

  test("an unknown or unpublished package directory is not reported", () => {
    // Otherwise the gate demands a changeset for something `changeset version` will never bump, and
    // the only way to satisfy it is a changeset that names a package changesets rejects.
    expect(
      uncoveredPackages(["packages/private-thing/src/index.ts"], packages, new Set()).size,
    ).toBe(0)
  })

  test("the example list is bounded, but the package is still reported once", () => {
    const many = Array.from({ length: 12 }, (_, index) => `packages/core/src/file-${index}.ts`)
    const uncovered = uncoveredPackages(many, packages, new Set())
    expect(uncovered.size).toBe(1)
    expect(uncovered.get("@nifrajs/core")?.length).toBe(5)
  })
})

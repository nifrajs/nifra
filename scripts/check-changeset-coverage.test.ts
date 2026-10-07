import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  changedFiles,
  declaredPackages,
  lastReleaseCommit,
  publishedPackages,
  uncoveredPackages,
} from "./check-changeset-coverage.ts"

/**
 * The gate's own gate. Its failure mode is the one it exists to catch: a check that never fails looks
 * exactly like a repository that never forgets a changeset.
 */

const fixture = async (): Promise<string> => await mkdtemp(join(tmpdir(), "changeset-coverage-"))

const git = (root: string, ...args: string[]): string => {
  const proc = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=nifra",
      "-c",
      "user.email=nifra@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  )
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

const put = async (root: string, path: string, text: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}

const commitAll = (root: string, message: string): string => {
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", message)
  return git(root, "rev-parse", "HEAD")
}

const repository = async (): Promise<string> => {
  const root = await fixture()
  git(root, "init", "-q")
  return root
}

describe("release anchor and changed files", () => {
  test("a commit that only drops a changeset is not a release", async () => {
    const root = await repository()
    await put(root, ".changeset/a.md", '---\n"@nifrajs/core": patch\n---\n\nA.\n')
    await put(root, ".changeset/b.md", '---\n"@nifrajs/core": patch\n---\n\nB.\n')
    await put(root, "packages/core/CHANGELOG.md", "# @nifrajs/core\n")
    commitAll(root, "start")
    await rm(join(root, ".changeset/a.md"))
    await put(root, "packages/core/CHANGELOG.md", "# @nifrajs/core\n\n## 1.0.1\n\nA.\n")
    const release = commitAll(root, "version packages")
    await rm(join(root, ".changeset/b.md"))
    commitAll(root, "drop a changeset")
    expect(lastReleaseCommit(root)).toBe(release)
  })

  test("a squash-merged release that bumps a version is a release though it deletes no changeset", async () => {
    const root = await repository()
    const manifest = (version: string): string =>
      `{\n  "name": "@nifrajs/core",\n  "version": "${version}"\n}\n`
    await put(root, "packages/core/package.json", manifest("1.0.0"))
    await put(root, "packages/core/test/fixture/package.json", manifest("0.0.0"))
    await put(root, "packages/core/CHANGELOG.md", "# @nifrajs/core\n")
    commitAll(root, "start")
    // The release branch added its changeset and consumed it, so the squash keeps only its outcome.
    await put(root, "packages/core/package.json", manifest("1.0.1"))
    await put(root, "packages/core/CHANGELOG.md", "# @nifrajs/core\n\n## 1.0.1\n\nA.\n")
    const release = commitAll(root, "chore(release): prepare (#2)")
    await put(root, "packages/core/CHANGELOG.md", "# @nifrajs/core\n\n## 1.0.1\n\nA, reworded.\n")
    await put(root, "packages/core/test/fixture/package.json", manifest("0.0.1"))
    commitAll(root, "reword a note and bump a fixture")
    expect(lastReleaseCommit(root)).toBe(release)
  })

  test("a file moved out of a package's src counts against the package it left", async () => {
    const root = await repository()
    await put(root, "packages/core/src/moved.ts", "export const moved = 1\n".repeat(20))
    const base = commitAll(root, "start")
    await mkdir(join(root, "packages/web/src"), { recursive: true })
    git(root, "mv", "packages/core/src/moved.ts", "packages/web/src/moved.ts")
    await put(root, "packages/core/src/café.ts", "export const cafe = 1\n")
    const moved = commitAll(root, "move")
    expect(changedFiles(base, root)).toEqual(
      expect.arrayContaining(["packages/core/src/moved.ts", "packages/core/src/café.ts"]),
    )
    await mkdir(join(root, "packages/client/src"), { recursive: true })
    git(root, "mv", "packages/web/src/moved.ts", "packages/client/src/moved.ts")
    expect(changedFiles(moved, root)).toContain("packages/web/src/moved.ts")
  })
})

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
    [
      "core",
      {
        dir: "core",
        name: "@nifrajs/core",
        publishValidation: "library" as const,
      },
    ],
    [
      "client",
      {
        dir: "client",
        name: "@nifrajs/client",
        publishValidation: "library" as const,
      },
    ],
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

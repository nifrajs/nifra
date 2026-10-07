import { describe, expect, test } from "bun:test"
import {
  firstParagraphs,
  NOTES_LIMIT,
  ownChanges,
  releaseNotes,
  versionSection,
} from "./release-notes.ts"

const CHANGELOG = `# @nifrajs/web

## 2.0.1

### Patch Changes

- abc1234: A fix of its own.

  A second paragraph with code:

  \`\`\`ts
  const x = 1
  \`\`\`

  - @nifrajs/core@2.0.1
  - @nifrajs/island-trigger@2.0.1

## 2.0.0

### Major Changes

- def5678: An older change.
`

const DEPENDENCIES_ONLY = `# @nifrajs/client

## 2.0.1

### Patch Changes

- Updated dependencies [abc1234]
  - @nifrajs/core@2.0.1
  - create-nifra@2.0.1

## 2.0.0
`

describe("versionSection", () => {
  test("reads one version's section, whatever the line endings", () => {
    expect(versionSection(CHANGELOG.replaceAll("\n", "\r\n"), "2.0.0")?.trim()).toBe(
      "### Major Changes\n\n- def5678: An older change.",
    )
    expect(versionSection(CHANGELOG, "2.0.1")).not.toContain("older")
    expect(versionSection(CHANGELOG, "9.9.9")).toBeUndefined()
  })
})

describe("ownChanges", () => {
  test("keeps a package's own entries whole and drops the dependency bumps listed under them", () => {
    const own = ownChanges(versionSection(CHANGELOG, "2.0.1") ?? "")
    expect(own).toContain("- abc1234: A fix of its own.")
    expect(own).toContain("const x = 1")
    expect(own).not.toContain("@nifrajs/core@2.0.1")
    expect(own).not.toContain("island-trigger")
  })

  test("a section of dependency bumps alone, in either shape, or an empty one has no changes", () => {
    expect(ownChanges(versionSection(DEPENDENCIES_ONLY, "2.0.1") ?? "")).toBeUndefined()
    expect(ownChanges("### Patch Changes\n\n- @nifrajs/core@2.0.1\n- create-nifra@2.0.1\n")).toBe(
      undefined,
    )
    expect(ownChanges("")).toBeUndefined()
  })

  test("a change-type heading left with only dependency bumps under it goes with them", () => {
    expect(
      ownChanges(
        "### Minor Changes\n\n- 1111111: A feature.\n\n### Patch Changes\n\n- @nifrajs/core@2.1.0\n",
      ),
    ).toBe("### Minor Changes\n\n- 1111111: A feature.")
  })
})

test("firstParagraphs keeps each entry's first paragraph and the headings", () => {
  expect(
    firstParagraphs(
      "### Patch Changes\n\n- a: First.\n  Still first.\n\n  Second.\n\n  ```ts\n  x\n  ```\n- b: Only one.",
    ),
  ).toBe("### Patch Changes\n\n- a: First.\n  Still first.\n\n- b: Only one.")
})

describe("releaseNotes", () => {
  const pkg = (name: string, changelog: string) => ({
    name,
    changelog,
    url: `https://example.invalid/${name}`,
  })

  test("lists the packages with changes of their own, in code-unit order, in full", () => {
    const notes = releaseNotes("2.0.1", [
      pkg("create-nifra", CHANGELOG),
      pkg("@nifrajs/client", DEPENDENCIES_ONLY),
      pkg("@nifrajs/web", CHANGELOG),
    ])
    expect(notes.startsWith("All public packages are released together at 2.0.1.")).toBe(true)
    expect([...notes.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual([
      "@nifrajs/web",
      "create-nifra",
    ])
    expect(notes).toContain("A second paragraph with code:")
    expect(notes).not.toContain("example.invalid")
  })

  test("notes too long for a GitHub release keep first paragraphs, then name the rest", () => {
    const long = (hash: string) =>
      `## 2.0.1\n\n### Patch Changes\n\n- ${hash}: Summary of ${hash}.\n\n  ${"Detail. ".repeat(2_000)}\n`
    const packages = Array.from({ length: 80 }, (_, index) =>
      pkg(`@nifrajs/p${String(index).padStart(2, "0")}`, long(`h${index}`)),
    )
    const notes = releaseNotes("2.0.1", packages)
    expect(notes.length).toBeLessThanOrEqual(NOTES_LIMIT)
    expect(notes).toContain("## [@nifrajs/p00](https://example.invalid/@nifrajs/p00)")
    expect(notes).toContain("- h0: Summary of h0.")
    expect(notes).not.toContain("Detail.")
    const named = [...notes.matchAll(/\[(@nifrajs\/p\d+)\]/g)].map((match) => match[1])
    expect(new Set(named).size).toBe(80)
  })
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { checkPacked, type PackedCheckOptions } from "./check-packed.ts"

let root: string

const write = (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

const pkg = (dir: string, name: string, files: Readonly<Record<string, string>>): void => {
  write(
    `${dir}/package.json`,
    JSON.stringify({ name, version: "1.0.0", files: ["dist", "CHANGELOG.md"] }),
  )
  write(`${dir}/LICENSE`, "MIT")
  write(`${dir}/CHANGELOG.md`, `# ${name}\n\n## 1.0.0\n`)
  for (const [path, text] of Object.entries(files)) write(`${dir}/${path}`, text)
}

const run = (overrides: Partial<PackedCheckOptions> = {}) =>
  checkPacked({
    root,
    packages: [
      { name: "@x/a", dir: "packages/a" },
      { name: "@x/b", dir: "packages/b" },
    ],
    markers: ["zqx-hidden"],
    release: false,
    update: false,
    npm: false,
    ...overrides,
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-packed-"))
  pkg("packages/a", "@x/a", { "dist/index.js": "export {}", "src/index.ts": "export {}" })
  pkg("packages/b", "@x/b", { "dist/index.js": "export {}" })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test("--update records what each package packs, and a clean release run then passes", async () => {
  const updated = await run({ update: true })
  expect(updated.failures).toEqual([])
  expect(JSON.parse(readFileSync(join(root, "packed-files.json"), "utf8"))).toEqual({
    "@x/a": ["CHANGELOG.md", "LICENSE", "dist/index.js", "package.json"],
    "@x/b": ["CHANGELOG.md", "LICENSE", "dist/index.js", "package.json"],
  })
  const release = await run({ release: true, npm: true })
  expect(release.failures).toEqual([])
  expect(release.fileCount).toBe(8)
}, 60_000)

test("a file the record lacks is only reported outside a release, and fails a release", async () => {
  await run({ update: true })
  write("packages/b/dist/extra.js", "export {}")
  const local = await run()
  expect(local.failures).toEqual([])
  expect(local.notes.join("\n")).toContain("@x/b: 1 file(s) added, 0 removed\n    + dist/extra.js")
  const release = await run({ release: true, npm: true })
  expect(release.failures.join("\n")).toContain("    + dist/extra.js")
}, 60_000)

test("a shipped test, environment file or marker fails, and the marker is not echoed", async () => {
  write("packages/a/dist/index.test.js", "test()")
  write("packages/a/dist/.env", "TOKEN=x")
  write("packages/b/dist/index.js", "// for ZQX-HIDDEN only")
  const { failures } = await run()
  expect(failures).toEqual([
    "@x/a/dist/.env: an environment file",
    "@x/a/dist/index.test.js: a test file",
    "@x/b/dist/index.js: private marker present",
  ])
  expect(failures.join("\n").toLowerCase()).not.toContain("zqx-hidden")
}, 60_000)

test("a release run needs markers and npm", async () => {
  await run({ update: true })
  const { failures } = await run({ release: true, markers: [], npm: false })
  expect(failures).toEqual([
    "PRIVATE_MARKERS must be non-empty in release mode",
    "npm is not on PATH: cannot confirm npm publishes the scanned files",
  ])
}, 60_000)

test("a package that cannot be packed fails instead of dropping out", async () => {
  rmSync(join(root, "packages/b/package.json"))
  const { failures } = await run()
  expect(failures).toHaveLength(1)
  expect(failures[0]).toStartWith("@x/b: bun pm pack failed")
}, 60_000)

test("npm selecting other files than bun packed fails, naming the difference", async () => {
  const npmFiles = async (dir: string) =>
    basename(dir) === "b"
      ? ["CHANGELOG.md", "LICENSE", "dist/index.js", "dist/stray.js", "package.json"]
      : "boom"
  const { failures } = await run({ npm: true, npmFiles })
  expect(failures).toEqual([
    "@x/a: boom",
    "@x/b: npm would publish a different file set than the one scanned: 1 file(s) added, 0 removed\n    + dist/stray.js",
  ])
}, 60_000)

test("a package without its LICENSE fails", async () => {
  rmSync(join(root, "packages/a/LICENSE"))
  expect((await run()).failures).toEqual(["@x/a: ships no LICENSE file"])
}, 60_000)

test("a CHANGELOG.md the package has but does not pack fails", async () => {
  write(
    "packages/a/package.json",
    JSON.stringify({ name: "@x/a", version: "1.0.0", files: ["dist"] }),
  )
  expect((await run()).failures).toEqual(["@x/a: ships no CHANGELOG.md"])
}, 60_000)

test("a CHANGELOG.md without a section for the package's version fails", async () => {
  write("packages/b/CHANGELOG.md", "# @x/b\n\n## 0.9.0\n")
  expect((await run()).failures).toEqual([
    "@x/b: CHANGELOG.md's newest section is `## 0.9.0`, not `## 1.0.0`",
  ])
}, 60_000)

test("a package with no CHANGELOG.md yet is only reported outside a release, and fails a release", async () => {
  rmSync(join(root, "packages/a/CHANGELOG.md"))
  await run({ update: true })
  const local = await run()
  expect(local.failures).toEqual([])
  expect(local.notes).toContain("@x/a: no CHANGELOG.md yet (enforced under RELEASE_MODE=1)")
  expect((await run({ release: true, npm: true })).failures).toEqual([
    "@x/a: ships no CHANGELOG.md",
  ])
}, 60_000)

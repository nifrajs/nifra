import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  contentFindings,
  describeDrift,
  fileListDrift,
  neverShipped,
  privateMarkers,
  readTarball,
  renderSnapshot,
} from "./packed-contents.ts"

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

test("paths that must never ship are named with the reason, and templates keep their starter test", () => {
  expect(
    neverShipped([
      "dist/index.js",
      "dist/index.js.map",
      "src/server.test.ts",
      "dist/types.test-d.ts",
      "template/backend/app.test.ts",
      "template-site/routes/index.spec.tsx",
      "node_modules/x/index.js",
      "dist/.tmp-build-1/a.js",
      "fixtures/.private/notes.md",
      ".env",
      ".env.local",
      "template/.env.example",
      "certs/server.pem",
      "debug.log",
      "dist/tsconfig.tsbuildinfo",
      "src/.DS_Store",
    ]),
  ).toEqual([
    "src/server.test.ts: a test file",
    "dist/types.test-d.ts: a test file",
    "node_modules/x/index.js: a local, generated or private directory",
    "dist/.tmp-build-1/a.js: a local, generated or private directory",
    "fixtures/.private/notes.md: a local, generated or private directory",
    ".env: an environment file",
    ".env.local: an environment file",
    "certs/server.pem: key material",
    "debug.log: a log, archive, database or build cache",
    "dist/tsconfig.tsbuildinfo: a log, archive, database or build cache",
    "src/.DS_Store: OS metadata",
  ])
})

test("a marker is found in any case and never echoed; a home-directory path is named", () => {
  const found = contentFindings(
    [
      { path: "README.md", bytes: encode("Built for Zqx-Hidden teams") },
      { path: "dist/index.js.map", bytes: encode('{"sources":["/Users/someone/repo/src/a.ts"]}') },
      { path: "dist/ci.js.map", bytes: encode('{"sources":["/home/runner/work/x/src/a.ts"]}') },
      { path: "dist/ok.js", bytes: encode("// see /private/var/folders for the temp root") },
      { path: "logo.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]) },
    ],
    ["zqx-hidden"],
  )
  expect(found).toEqual([
    "README.md: private marker present",
    "dist/index.js.map: absolute home-directory path",
    "dist/ci.js.map: absolute home-directory path",
  ])
  expect(found.join("\n").toLowerCase()).not.toContain("zqx-hidden")
})

test("markers come from a comma list with blanks dropped", () => {
  expect(privateMarkers(undefined)).toEqual([])
  expect(privateMarkers(" , ,")).toEqual([])
  expect(privateMarkers("a, b ,,c")).toEqual(["a", "b", "c"])
})

test("file-list drift names what was added and removed, and nothing when equal", () => {
  const drift = fileListDrift(["a", "b"], ["b", "c"])
  expect(drift).toEqual({ added: ["c"], removed: ["a"] })
  expect(describeDrift("@x/y", drift)).toBe("@x/y: 1 file(s) added, 1 removed\n    + c\n    - a")
  expect(describeDrift("@x/y", fileListDrift(["a"], ["a"]))).toBeUndefined()
  expect(fileListDrift(undefined, ["a"])).toEqual({ added: ["a"], removed: [] })
  const many = describeDrift(
    "@x/y",
    fileListDrift(
      [],
      Array.from({ length: 25 }, (_, i) => `f${i}`),
    ),
  )
  expect(many?.split("\n").at(-1)).toBe("    … and 5 more")
})

test("the snapshot is written in code-unit order of package name", () => {
  expect(renderSnapshot({ b: ["x"], "@a/z": ["y"], a: [] })).toBe(
    '{\n  "@a/z": [\n    "y"\n  ],\n  "a": [],\n  "b": [\n    "x"\n  ]\n}\n',
  )
})

test("a tarball is read whole, its top directory dropped, dotfiles included", () => {
  const dir = mkdtempSync(join(tmpdir(), "packed-contents-"))
  try {
    mkdirSync(join(dir, "package", "dist"), { recursive: true })
    writeFileSync(join(dir, "package", "package.json"), "{}")
    writeFileSync(join(dir, "package", "dist", "index.js"), "export {}")
    writeFileSync(join(dir, "package", ".npmrc"), "x")
    const tgz = join(dir, "p.tgz")
    expect(spawnSync("tar", ["-czf", tgz, "-C", dir, "package"]).status).toBe(0)
    const files = readTarball(tgz)
    expect(files.map((file) => file.path)).toEqual([".npmrc", "dist/index.js", "package.json"])
    expect(new TextDecoder().decode(files[1]!.bytes)).toBe("export {}")
    expect(() => readTarball(join(dir, "missing.tgz"))).toThrow(/tar -xzf/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

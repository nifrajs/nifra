import { afterAll, describe, expect, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RoutesDiff } from "@nifrajs/core/diff"
import { bindCommandArgv, findCommandSpec } from "../src/command-catalog.ts"
import {
  DEFAULT_SNAPSHOT_FILE,
  diffAgainstBaseline,
  formatDiff,
  parseSnapshotFile,
  type SnapshotFile,
} from "../src/diff-tool.ts"

// Fixtures live INSIDE the package so the dynamically imported backend/app.ts resolves @nifrajs/* from
// the workspace (a system tmp dir has no node_modules above it).
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

const FIXTURES = createFixtureRoot("tmp-nifra-diff-fixtures")

afterAll(() => {
  removeFixtureRoot(FIXTURES)
})

const BACKEND_V1 = `import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
export const backend = server()
  .post("/users", { body: t.object({ name: t.string() }), response: t.object({ id: t.string() }) }, (c) => ({ id: "1" }))
  .get("/health", (c) => ({ ok: true }))
`

// v2 renames the response field (breaking) and adds a route (compatible).
const BACKEND_V2 = `import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
export const backend = server()
  .post("/users", { body: t.object({ name: t.string() }), response: t.object({ userId: t.string() }) }, (c) => ({ userId: "1" }))
  .get("/health", (c) => ({ ok: true }))
  .get("/version", (c) => ({ v: 2 }))
`

/** Run a catalog command the way `nifra <name>` does. */
async function nifra(name: string, cwd: string, argv: readonly string[] = []) {
  const spec = findCommandSpec(name)
  if (spec === undefined) throw new Error(`${name} command missing`)
  const input = bindCommandArgv(spec, [...argv])
  const output = await spec.run(input, { cwd, cliVersion: "0.0.0" })
  return {
    ok: spec.success?.(output, input) ?? true,
    data: spec.json?.(output, input) ?? output,
    text: spec.render(output, input).join("\n"),
  }
}

async function project(name: string, backendSource: string): Promise<string> {
  const dir = join(FIXTURES, name)
  writeAppFile(dir, "backend/app.ts", backendSource)
  return dir
}

describe("parseSnapshotFile", () => {
  test("rejects invalid JSON and foreign shapes with actionable errors", () => {
    expect(() => parseSnapshotFile("not json", "x.json")).toThrow("not valid JSON")
    expect(() => parseSnapshotFile('{"routes": []}', "x.json")).toThrow("not a nifra API snapshot")
    expect(() => parseSnapshotFile("null", "x.json")).toThrow("not a nifra API snapshot")
    const ok = parseSnapshotFile('{"nifraSnapshot": 1, "routes": []}', "x.json")
    expect(ok.routes).toEqual([])
  })
})

describe("formatDiff", () => {
  test("orders breaking first and summarizes the gate verdict", () => {
    const diff: RoutesDiff = {
      hasBreaking: true,
      changes: [
        {
          severity: "compatible",
          method: "GET",
          path: "/a",
          section: "route",
          message: "route added",
        },
        {
          severity: "breaking",
          method: "GET",
          path: "/b",
          section: "response",
          field: "id",
          message: 'field "id" removed',
        },
      ],
    }
    const text = formatDiff(diff)
    expect(text.indexOf("✖ breaking")).toBeLessThan(text.indexOf("✓ compatible"))
    expect(text).toContain("1 breaking change - existing clients will fail.")
    expect(formatDiff({ hasBreaking: false, changes: [] })).toBe("No API contract changes.")
  })
})

describe("nifra snapshot + nifra diff over a real backend/app.ts", () => {
  test("snapshot → identical diff passes; contract break fails the gate", async () => {
    const v1 = await project("v1", BACKEND_V1)
    await nifra("snapshot", v1)
    const snapshotPath = join(v1, DEFAULT_SNAPSHOT_FILE)
    const written = parseSnapshotFile(await Bun.file(snapshotPath).text(), snapshotPath)
    expect(written.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /users",
      "GET /health",
    ])

    // Same contract → gate passes.
    const same = await nifra("diff", v1)
    expect(same.ok).toBe(true)
    expect(same.text).toBe("No API contract changes.")

    // v2 renames a response field → gate fails against the v1 baseline.
    const v2 = await project("v2", BACKEND_V2)
    await writeFile(join(v2, DEFAULT_SNAPSHOT_FILE), JSON.stringify(written))
    const broken = await nifra("diff", v2, [DEFAULT_SNAPSHOT_FILE, "--json"])
    expect(broken.ok).toBe(false)
    expect(Object.keys(Object(broken.data))).toEqual(["ok", "hasBreaking", "changes"])
    expect(broken.text).toContain("1 breaking change - existing clients will fail.")
  })

  test("missing baseline, missing backend and the retired layout fail with actionable errors", async () => {
    const v1 = await project("v1-errors", BACKEND_V1)
    await expect(nifra("diff", v1, ["nope.json"])).rejects.toThrow(
      "nope.json - create it on your main branch with `nifra snapshot`.",
    )
    const empty = join(FIXTURES, "empty")
    await mkdir(empty, { recursive: true })
    await expect(nifra("snapshot", empty)).rejects.toThrow("no backend/app.ts")
    writeAppFile(empty, "backend/app.ts", "export const other = 1\n")
    await expect(nifra("snapshot", empty)).rejects.toThrow("does not export")
    const retired = join(FIXTURES, "retired")
    writeAppFile(retired, "backend.ts", BACKEND_V1)
    await expect(nifra("snapshot", retired)).rejects.toThrow(
      "Run `nifra migrate layout` to see the move",
    )
  })

  test("a contained diff refuses a baseline outside the project, through a symlink too", async () => {
    const v1 = await project("v1-contained", BACKEND_V1)
    await nifra("snapshot", v1)
    const outside = join(FIXTURES, "outside.json")
    await writeFile(outside, await Bun.file(join(v1, DEFAULT_SNAPSHOT_FILE)).text())
    symlinkSync(outside, join(v1, "linked.json"))
    for (const path of ["../outside.json", "linked.json"]) {
      await expect(diffAgainstBaseline(v1, path, { contain: true })).rejects.toThrow(
        `the baseline ${path} is outside the project directory`,
      )
      expect((await diffAgainstBaseline(v1, path)).hasBreaking).toBe(false)
    }
  })

  test("--out writes to the chosen path", async () => {
    const v1 = await project("v1-out", BACKEND_V1)
    await nifra("snapshot", v1, ["--out", "contracts/api.json"])
    const file: SnapshotFile = parseSnapshotFile(
      await Bun.file(join(v1, "contracts/api.json")).text(),
      "contracts/api.json",
    )
    expect(file.nifraSnapshot).toBe(1)
  })
})

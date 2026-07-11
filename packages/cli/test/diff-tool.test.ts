import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RoutesDiff } from "@nifrajs/core/diff"
import {
  DEFAULT_SNAPSHOT_FILE,
  formatDiff,
  parseSnapshotFile,
  runDiff,
  runSnapshot,
  type SnapshotFile,
} from "../src/diff-tool.ts"

// Fixtures live INSIDE the package so the dynamically imported backend.ts resolves @nifrajs/* from
// the workspace (a system tmp dir has no node_modules above it).
const FIXTURES = join(import.meta.dir, ".tmp-nifra-diff-fixtures")

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true })
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

async function project(name: string, backendSource: string): Promise<string> {
  const dir = join(FIXTURES, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "backend.ts"), backendSource)
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
    expect(text).toContain("1 breaking change — existing clients will fail.")
    expect(formatDiff({ hasBreaking: false, changes: [] })).toBe("No API contract changes.")
  })
})

describe("runSnapshot + runDiff over a real backend.ts", () => {
  test("snapshot → identical diff passes; contract break fails the gate", async () => {
    const v1 = await project("v1", BACKEND_V1)
    await runSnapshot(v1, {})
    const snapshotPath = join(v1, DEFAULT_SNAPSHOT_FILE)
    const written = parseSnapshotFile(await Bun.file(snapshotPath).text(), snapshotPath)
    expect(written.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /users",
      "GET /health",
    ])

    // Same contract → gate passes.
    expect(await runDiff(v1, DEFAULT_SNAPSHOT_FILE, {})).toBe(true)

    // v2 renames a response field → gate fails against the v1 baseline.
    const v2 = await project("v2", BACKEND_V2)
    await writeFile(join(v2, DEFAULT_SNAPSHOT_FILE), JSON.stringify(written))
    expect(await runDiff(v2, DEFAULT_SNAPSHOT_FILE, { json: true })).toBe(false)
  })

  test("missing baseline and missing backend fail with actionable errors", async () => {
    const v1 = await project("v1-errors", BACKEND_V1)
    await expect(runDiff(v1, "nope.json", {})).rejects.toThrow("baseline not found")
    const empty = join(FIXTURES, "empty")
    await mkdir(empty, { recursive: true })
    await expect(runSnapshot(empty, {})).rejects.toThrow("no backend.ts")
    await writeFile(join(empty, "backend.ts"), "export const other = 1\n")
    await expect(runSnapshot(empty, {})).rejects.toThrow("does not export")
  })

  test("--out writes to the chosen path", async () => {
    const v1 = await project("v1-out", BACKEND_V1)
    await runSnapshot(v1, { out: "contracts/api.json" })
    const file: SnapshotFile = parseSnapshotFile(
      await Bun.file(join(v1, "contracts/api.json")).text(),
      "contracts/api.json",
    )
    expect(file.nifraSnapshot).toBe(1)
  })
})

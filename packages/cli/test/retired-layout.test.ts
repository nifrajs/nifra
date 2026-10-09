import { afterAll, describe, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const FIXTURES = createFixtureRoot("tmp-retired-layout-")
afterAll(() => removeFixtureRoot(FIXTURES))

const BACKEND =
  'import { server } from "@nifrajs/core"\nexport const backend = server().get("/health", () => "ok")\n'

function app(files: Record<string, string>): string {
  const root = createFixtureProject(FIXTURES, "app-")
  for (const [path, content] of Object.entries(files)) writeAppFile(root, path, content)
  return root
}

describe("NF-C038 retired root layout", () => {
  test("a root backend.ts or framework.ts fails the check and names the migration", async () => {
    const root = app({ "backend.ts": BACKEND, "framework.ts": "export const adapter = {}\n" })
    const result = await collectCheckResult(root, { lintsOnly: true })
    const found = result.diagnostics.filter((d) => d.code === "NF-C038")
    expect(found.map((d) => [d.file, d.severity])).toEqual([
      ["backend.ts", "error"],
      ["framework.ts", "error"],
    ])
    expect(found[0]?.message).toStartWith(
      "backend.ts is the retired root layout; nifra reads it at backend/app.ts. Until it moves, nifra check runs no contract gate",
    )
    expect(found[0]?.message).toEndWith("`nifra migrate layout` shows the move; `--write` makes it")
    expect(result.ok).toBe(false)
  })

  test("a library's backend.ts module is not the layout; in a routed app any root backend.ts is", async () => {
    const module = 'export const app = { fetch: () => new Response("ok") }\n'
    const library = app({ "backend.ts": module, "server.ts": 'import { app } from "./backend"\n' })
    const plain = await collectCheckResult(library, { lintsOnly: true })
    expect(plain.diagnostics.filter((d) => d.code === "NF-C038")).toEqual([])
    const routed = app({ "backend.ts": module, "routes/index.tsx": "export default () => null\n" })
    const old = await collectCheckResult(routed, { lintsOnly: true })
    expect(old.diagnostics.filter((d) => d.code === "NF-C038").map((d) => d.file)).toEqual([
      "backend.ts",
    ])
  })

  test("the current layout gets nothing", async () => {
    const root = app({ "backend/app.ts": BACKEND })
    const result = await collectCheckResult(root, { lintsOnly: true })
    expect(result.diagnostics.filter((d) => d.code === "NF-C038")).toEqual([])
  })
})

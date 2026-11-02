import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-undeclared-response-")
})
afterEach(() => removeFixtureRoot(root))

const findings = async (): Promise<readonly string[]> => {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((diagnostic) => diagnostic.code === "NF-C054")
    .map((diagnostic) => `${diagnostic.file}:${diagnostic.line} ${diagnostic.severity}`)
}

const ROUTES = `import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"
const item = t.object({ id: t.string() })
const shared = { response: item }
const list = () => [{ id: "a" }]
export const app = server()
  .get("/items", list)
  .get("/items/:id", { response: item }, (c) => ({ id: c.params.id }))
  .post("/items", { body: item }, (c) => c.body)
  .get("/shared", shared, () => ({ id: "a" }))
  .get("/file", () => new Response("bytes"))
  // nifra-expect NF-C054: a health probe, not part of the published API
  .get("/health", () => "ok")
`

test("a route without a response schema is reported where the project serves openapi()", async () => {
  writeAppFile(root, "backend/routes.ts", ROUTES)
  writeAppFile(
    root,
    "backend/app.ts",
    `import { openapi } from "@nifrajs/middleware"
import { server } from "@nifrajs/core/server"
import { app as routes } from "./routes.ts"
export const app = server().use(openapi()).merge(routes)
`,
  )
  // The declared route, the one whose options a variable holds, the raw Response NF-C007 reports
  // and the marked probe are left out.
  expect(await findings()).toEqual(["backend/routes.ts:7 info", "backend/routes.ts:9 info"])
})

test("toOpenAPI counts as publishing the document, and a type-only import does not", async () => {
  writeAppFile(root, "backend/routes.ts", ROUTES)
  writeAppFile(
    root,
    "scripts/types.ts",
    `import type { toOpenAPI } from "@nifrajs/schema/openapi"
export type Build = typeof toOpenAPI
`,
  )
  expect(await findings()).toEqual([])
  writeAppFile(
    root,
    "scripts/spec.ts",
    `import { toOpenAPI } from "@nifrajs/schema"
import { app } from "../backend/routes.ts"
export const spec = toOpenAPI(app)
`,
  )
  expect(await findings()).toEqual(["backend/routes.ts:7 info", "backend/routes.ts:9 info"])
})

test("a call with a path but no handler is not a route, whatever the method name", async () => {
  // headers.get("etag"), searchParams.get("id"), map.delete("/"): every registration takes a handler.
  const lines = [
    `import { openapi } from "@nifrajs/middleware"`,
    `import { server } from "@nifrajs/core/server"`,
    `declare const store: Record<string, (key: string, options?: object) => unknown>`,
    `export const app = server().use(openapi())`,
  ]
  const expected: string[] = []
  for (const method of ["get", "post", "put", "patch", "delete", "head", "options", "all"]) {
    lines.push(`store.${method}("/${method}")`, `store.${method}("/${method}", { fallback: 1 })`)
    lines.push(`app.${method}("/${method}", { query: {} }, () => "ok")`)
    expected.push(`backend/app.ts:${lines.length} info`)
  }
  writeAppFile(root, "backend/app.ts", `${lines.join("\n")}\n`)
  expect(await findings()).toEqual(expected)
})

test("a project that builds no document is not reported", async () => {
  writeAppFile(root, "backend/routes.ts", ROUTES)
  expect(await findings()).toEqual([])
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-text-slot-boolean-")
})
afterEach(() => removeFixtureRoot(root))

const findings = async (): Promise<readonly string[]> => {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((diagnostic) => diagnostic.code === "NF-C055")
    .map((diagnostic) => `${diagnostic.file}:${diagnostic.line} ${diagnostic.severity}`)
}

test("a coerce.boolean() a query, headers or cookies schema reaches is reported once", async () => {
  writeAppFile(
    root,
    "backend/routes.ts",
    `import { server } from "@nifrajs/core/server"
import { z } from "zod"
const archived = z.coerce.boolean()
const Filters = z.object({ archived, page: z.coerce.number() })
const options = { cookies: z.object({ compact: z.coerce.boolean().optional() }) }
export const app = server()
  .get("/notes", { query: Filters }, (c) => c.query)
  .get("/notes/count", { query: Filters }, (c) => c.query)
  .get("/feed", { headers: z.object({ "x-draft": z.coerce.boolean() }) }, (c) => c.headers)
  .get("/view", options, (c) => c.cookies)
  .post("/notes", { body: z.object({ pinned: z.coerce.boolean() }) }, (c) => c.body)
  .get("/kept", {
    // nifra-expect NF-C055: the client sends 1 or nothing
    query: z.object({ flag: z.coerce.boolean() }),
  }, (c) => c.query)
  .get("/words", { query: z.object({ archived: z.stringbool() }) }, (c) => c.query)
`,
  )
  // The shared const once, the inline header, the options a variable holds; the JSON body, the
  // marked one and z.stringbool() are left out.
  expect(await findings()).toEqual([
    "backend/routes.ts:3 warning",
    "backend/routes.ts:5 warning",
    "backend/routes.ts:9 warning",
  ])
})

test("options passed to a call with no handler are not a route's, whatever the method name", async () => {
  const flag = "{ query: z.object({ on: z.coerce.boolean() }) }"
  const lines = [
    `import { server } from "@nifrajs/core/server"`,
    `import { z } from "zod"`,
    `import { handler } from "./handler.ts"`,
    `declare const store: Record<string, (key: string, options?: object) => unknown>`,
    `export const app = server()`,
  ]
  const expected: string[] = []
  for (const method of ["get", "post", "put", "patch", "delete", "head", "options", "all"]) {
    lines.push(`const ${method}Route = ${flag}`)
    expected.push(`backend/app.ts:${lines.length} warning`)
    lines.push(
      `const ${method}Read = ${flag}`,
      `store.${method}("/${method}", ${flag})`,
      `store.${method}("/${method}", ${method}Read)`,
      `app.${method}("/${method}", ${flag}, (c) => c.query)`,
    )
    expected.push(`backend/app.ts:${lines.length} warning`)
    lines.push(`app.${method}("/${method}/imported", ${method}Route, handler)`)
  }
  writeAppFile(root, "backend/app.ts", `${lines.join("\n")}\n`)
  expect(await findings()).toEqual(expected)
})

test("a named or namespace import of zod counts, and another library's coerce does not", async () => {
  writeAppFile(
    root,
    "backend/a.ts",
    `import { server } from "@nifrajs/core/server"
import * as zod from "zod/v4"
import { coerce } from "zod"
export const app = server()
  .get("/a", { query: zod.object({ on: zod.coerce.boolean() }) }, (c) => c.query)
  .get("/b", { query: zod.object({ on: coerce.boolean() }) }, (c) => c.query)
`,
  )
  writeAppFile(
    root,
    "backend/b.ts",
    `import { server } from "@nifrajs/core/server"
import { v } from "./valid.ts"
export const app = server().get("/c", { query: v.object({ on: v.coerce.boolean() }) }, (c) => c.query)
`,
  )
  expect(await findings()).toEqual(["backend/a.ts:5 warning", "backend/a.ts:6 warning"])
})

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { server } from "@nifrajs/core"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { compileSchema } from "../src/compile.ts"
import { t } from "../src/index.ts"
import { toOpenAPI } from "../src/openapi.ts"

const dir = mkdtempSync(join(import.meta.dir, ".tmp-text-slots-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const answer = async (
  app: { fetch(request: Request): Response | Promise<Response> },
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await app.fetch(new Request(`http://x${path}`, init))
  return { status: response.status, body: await response.json() }
}

const issuesOf = (schema: StandardSchemaV1, value: unknown): boolean => {
  const outcome = schema["~standard"].validate(value)
  if (outcome instanceof Promise) throw new Error("expected a synchronous validator")
  return outcome.issues !== undefined
}

describe("a t.object where a value arrives as text", () => {
  const filters = t.object({ archived: t.boolean(), page: t.optional(t.integer()) })
  const app = server()
    .get("/notes", { query: filters }, (c) => c.query)
    .get("/feed", { headers: t.object({ "x-limit": t.integer() }) }, (c) => c.headers)
    .get("/view", { cookies: t.object({ compact: t.boolean() }) }, (c) => c.cookies)
    .post("/notes", { body: filters }, (c) => c.body)

  test("reads the query, header and cookie text it declares", async () => {
    expect(await answer(app, "/notes?archived=true&page=2")).toEqual({
      status: 200,
      body: { archived: true, page: 2 },
    })
    expect(await answer(app, "/notes?archived=0")).toEqual({
      status: 200,
      body: { archived: false },
    })
    expect(await answer(app, "/feed", { headers: { "x-limit": "7" } })).toEqual({
      status: 200,
      body: { "x-limit": 7 },
    })
    expect(await answer(app, "/view", { headers: { cookie: "compact=FALSE" } })).toEqual({
      status: 200,
      body: { compact: false },
    })
  })

  test("refuses text that is not one of its values, and keys it does not declare", async () => {
    expect((await answer(app, "/notes?archived=yes")).status).toBe(422)
    expect((await answer(app, "/notes?archived=true&utm=x")).status).toBe(422)
  })

  test("leaves the same schema strict in a JSON body, and itself unchanged", async () => {
    const posted = await answer(app, "/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: "true" }),
    })
    expect(posted.status).toBe(422)
    expect(issuesOf(filters, { archived: "true" })).toBe(true)
    expect(issuesOf(filters, { archived: true })).toBe(false)
  })

  test("is listed with the literals it reads", () => {
    expect(toOpenAPI(app).paths["/notes"]?.get?.parameters?.[0]).toEqual({
      name: "archived",
      in: "query",
      required: true,
      schema: { type: "boolean" },
      "x-nifra-boolean-literals": {
        true: ["true", "1"],
        false: ["false", "0", "-0"],
        caseInsensitive: true,
      },
    })
  })
})

test("a precompiled t.object reads the same text as the one it was compiled from", async () => {
  const file = join(dir, "filters.ts")
  writeFileSync(
    file,
    compileSchema(t.object({ archived: t.boolean() }), { source: "./x.ts", exportName: "schema" }),
  )
  const compiled: StandardSchemaV1 = (await import(file)).schema
  const app = server().get("/notes", { query: compiled }, (c) => c.query)
  expect(await answer(app, "/notes?archived=false")).toEqual({
    status: 200,
    body: { archived: false },
  })
  expect((await answer(app, "/notes?archived=no")).status).toBe(422)
  expect(issuesOf(compiled, { archived: "false" })).toBe(true)
  expect(toOpenAPI(app).paths["/notes"]?.get?.parameters?.[0]).toHaveProperty(
    "x-nifra-boolean-literals",
  )
})

test("a schema that offers no text form gets the text as it came", async () => {
  const raw: StandardSchemaV1<unknown, unknown> = {
    "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
  }
  const app = server().get("/raw", { query: raw }, (c) => c.query)
  expect(await answer(app, "/raw?archived=true")).toEqual({
    status: 200,
    body: { archived: "true" },
  })
})

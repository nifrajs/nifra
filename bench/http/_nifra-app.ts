/**
 * The nifra app under benchmark — shared verbatim by the Bun server (serve.ts, via
 * `.listen()`) and the Node server (serve-node-nifra.ts, via `@nifrajs/node`'s `serve()`),
 * so the nifra row in BOTH runtime sections measures the identical app. Same routes +
 * validation as every other framework's bench server.
 */

import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import { server } from "@nifrajs/core"

function isUser(v: unknown): v is { name: string; age: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    "name" in v &&
    typeof v.name === "string" &&
    "age" in v &&
    typeof v.age === "number"
  )
}

function isSearch(v: unknown): v is { q: string; limit: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "q" in v &&
    typeof v.q === "string" &&
    "limit" in v &&
    typeof v.limit === "string"
  )
}

// nifra's idiomatic validation is any Standard Schema. Hand-rolled here (no lib) so the
// row measures nifra's validation *plumbing* (readAndValidateBody + the `~standard.validate`
// call), comparable to Hono's built-in validator — not the cost of a heavy schema lib.
const userBody: StandardSchemaV1<unknown, { name: string; age: number }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ name: string; age: number }> {
      return isUser(value)
        ? { value }
        : { issues: [{ message: "expected { name: string; age: number }" }] }
    },
    // type-only marker; the runtime value is never read (matches the spec tests).
    types: undefined as unknown as StandardTypes<unknown, { name: string; age: number }>,
  },
}

const searchQuery: StandardSchemaV1<unknown, { q: string; limit: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ q: string; limit: string }> {
      return isSearch(value)
        ? { value }
        : { issues: [{ message: "expected ?q=string&limit=string" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, { q: string; limit: string }>,
  },
}

export function makeNifraApp() {
  return server()
    .get("/", () => ({ hello: "world" }))
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .get("/search", { query: searchQuery }, (c) => ({ q: c.query.q, limit: c.query.limit }))
    .post("/users", { body: userBody }, (c) => ({ id: "1", name: c.body.name }))
}

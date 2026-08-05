/**
 * The nifra app under benchmark - shared verbatim by the Bun server (serve.ts, via
 * `.listen()`) and the Node server (serve-node-nifra.ts, via `@nifrajs/node`'s `serve()`),
 * so the nifra row in BOTH runtime sections measures the identical app. Same routes +
 * validation as every other framework's bench server.
 *
 * The `server` value import below deliberately points at the built `dist/` output, not the
 * `@nifrajs/core` package specifier. `@nifrajs/core`'s package.json resolves a "bun" export
 * condition straight to `src/server.ts` - correct for local app development, but it means a naive
 * `bun run serve.ts` benchmarks live TypeScript source, not what `bun add @nifrajs/core` actually
 * installs and runs. Measured: source ran ~2-4% faster than dist across three A/B rounds on a bare
 * GET (small, but consistent direction) - this is the number people rerun to check us, so it has to
 * measure the same artifact a real install gets. Type-only imports are unaffected (the "types"
 * condition already always points at `dist/*.d.ts`).
 */

import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core/server"
import { server } from "../../packages/core/dist/server.js"

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
// call), comparable to Hono's built-in validator - not the cost of a heavy schema lib.
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

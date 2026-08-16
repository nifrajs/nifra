/**
 * nifra's Cloudflare Workers row - `toFetchHandler(app)` over a nifra server, the shape
 * `@nifrajs/core/server`'s edge docblock shows (app built once at module scope, `export default`).
 *
 * Validation is a hand-rolled Standard Schema, exactly as bench/lambda/handler-nifra.ts does it, so
 * the POST row measures nifra's validation *plumbing* and not the cost of a schema library.
 *
 * The default export is the Workers module contract: `{ fetch(request, env, ctx) }`. The Workers
 * cold-start harness (bench/workers/run.ts) compiles this bundle in a fresh V8 context and invokes
 * `fetch` once - the isolate parse+init+first-request cost the edge charges before your Worker answers.
 */

import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core/server"
import { server, toFetchHandler } from "@nifrajs/core/server"
import { isUser } from "./_fixtures.ts"

const userBody: StandardSchemaV1<unknown, { name: string; age: number }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ name: string; age: number }> {
      return isUser(value)
        ? { value }
        : { issues: [{ message: "expected { name: string; age: number }" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, { name: string; age: number }>,
  },
}

const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: userBody }, (c) => ({ id: "1", name: c.body.name }))

export default toFetchHandler(app)

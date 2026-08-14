/**
 * nifra's Lambda row - `@nifrajs/aws-lambda`'s `handle()` over a nifra server, the shape the
 * package's own docblock shows (app built once at module scope, handler exported).
 *
 * Validation is a hand-rolled Standard Schema, exactly as bench/http/_nifra-app.ts does it, so the
 * POST row measures nifra's validation *plumbing* and not the cost of a schema library.
 *
 *   node <bundled handler-nifra.js> <cold|warm>
 */

import { handle } from "@nifrajs/aws-lambda"
import { server } from "@nifrajs/core"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core/server"
import { drive, isUser } from "./_drive.ts"

// First statement of the module body: ES module imports are all evaluated before it, so this
// already contains Node's boot, the bundle's parse, and every import's init. That is the number
// Lambda charges as the INIT phase.
const initMs = performance.now()

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

await drive("nifra", initMs, () => {
  const app = server()
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .post("/users", { body: userBody }, (c) => ({ id: "1", name: c.body.name }))
  return handle(app) as never
})

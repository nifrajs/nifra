/**
 * The SHIPPED `@nifrajs/edge` row - the real published package (not the _edge-server.ts prototype the
 * spike rows measured). Same entry shape as every other row (build once at module scope,
 * `toFetchHandler`, `export default`), same routes, same hand-rolled Standard Schema - so its gap
 * against `nifra` (full) is the real cost the compact package trades away, and its gap against the
 * `nifra-edge` spike is what keeping the full trust boundary (bounded body, proto-guard, byte-parity
 * envelopes) costs over a naked router.
 */

import { type StandardSchemaV1, server, toFetchHandler } from "@nifrajs/edge"
import { isUser } from "./_fixtures.ts"

const userBody: StandardSchemaV1<{ name: string; age: number }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value) {
      return isUser(value)
        ? { value }
        : { issues: [{ message: "expected { name: string; age: number }" }] }
    },
  },
}

const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: userBody }, (c) => ({ id: "1", name: c.body.name }))

export default toFetchHandler(app)

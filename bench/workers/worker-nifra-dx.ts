/**
 * "kernel WITH DX" row - the compact-edge SHELL (_edge-server.ts) driven through the SAME builder API
 * worker-nifra.ts uses against the full server. Identical entry shape (build once at module scope,
 * `toFetchHandler`, `export default`), identical semantics and the same hand-rolled Standard Schema,
 * so the ONLY difference from the `nifra` row is the shell vs the full `Server` - which is exactly the
 * DX-cost number Phase-1 needs before committing to the lane-registry extraction. See _edge-server.ts.
 */

import { type StandardSchemaV1, server, toFetchHandler } from "./_edge-server.ts"
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

import { expect, test } from "bun:test"
import { server } from "../src/index.ts"
import type { StandardResult, StandardSchemaV1 } from "../src/schema/standard.ts"

const query: StandardSchemaV1<unknown, { q: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-test",
    validate(value): StandardResult<{ q: string }> {
      return typeof value === "object" &&
        value !== null &&
        "q" in value &&
        typeof value.q === "string"
        ? { value: { q: value.q } }
        : { issues: [{ message: "q must be a string" }] }
    },
  },
}

test("synchronous lifecycle routes stay synchronous", () => {
  const app = server()
    .derive(() => ({ userId: "u1" }))
    .beforeHandle(() => undefined)
    .get("/search", { query }, (c) => ({ q: c.query.q, user: c.userId }))

  const result = app.fetch(new Request("http://x/search?q=ada"))
  expect(result).toBeInstanceOf(Response)
})

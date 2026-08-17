/**
 * Hono's `tiny` preset row - `import { Hono } from "hono/tiny"`, the smallest-bundle Hono (PatternRouter
 * only, no RegExpRouter/TrieRouter). This is Hono's own answer to a minimal edge bundle, so it is the
 * fair bundle-size peer to `@nifrajs/edge` - same routes, same idiomatic `validator` plumbing, same
 * entry shape as every other row.
 */

import { Hono } from "hono/tiny"
import { validator } from "hono/validator"
import { isUser } from "./_fixtures.ts"

const app = new Hono()
  .get("/users/:id", (c) => c.json({ id: c.req.param("id") }))
  .post(
    "/users",
    validator("json", (value, c) => (isUser(value) ? value : c.json({ error: "invalid" }, 400))),
    (c) => c.json({ id: "1", name: c.req.valid("json").name }),
  )

export default { fetch: (request: Request) => app.fetch(request) }

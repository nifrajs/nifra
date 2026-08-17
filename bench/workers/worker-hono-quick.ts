/**
 * Hono's `quick` preset row - `import { Hono } from "hono/quick"`, the preset tuned for runtimes that
 * recreate the isolate every request (LinearRouter, no build-time route compilation), which is exactly
 * the cold-start regime this bench measures. Same routes, same idiomatic `validator` plumbing, same
 * entry shape as every other row.
 */

import { Hono } from "hono/quick"
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

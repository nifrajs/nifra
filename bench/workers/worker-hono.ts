/**
 * Hono's Cloudflare Workers row - a Hono app exported as the Workers module contract, using Hono's
 * built-in validator so the POST row is its idiomatic plumbing, matching how the nifra row uses a
 * Standard Schema. Hono is Workers-native (`export default app`); the explicit `{ fetch }` wrapper
 * keeps the bundle's default export identical in shape to the other rows.
 */

import { Hono } from "hono"
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

/**
 * Hono's Lambda row - `hono/aws-lambda`'s `handle()` over a Hono app, using Hono's built-in
 * validator so the POST row is its idiomatic plumbing, matching how the nifra row uses a Standard
 * Schema.
 *
 *   node <bundled handler-hono.js> <cold|warm>
 */

import { Hono } from "hono"
import { handle } from "hono/aws-lambda"
import { validator } from "hono/validator"
import { drive, isUser } from "./_drive.ts"

// See handler-nifra.ts: first module-body statement, so imports are already paid for.
const initMs = performance.now()

await drive("hono", initMs, () => {
  const app = new Hono()
    .get("/users/:id", (c) => c.json({ id: c.req.param("id") }))
    .post(
      "/users",
      validator("json", (value, c) => (isUser(value) ? value : c.json({ error: "invalid" }, 400))),
      (c) => c.json({ id: "1", name: c.req.valid("json").name }),
    )
  return handle(app) as never
})

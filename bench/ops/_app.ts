/** The shared fixture app for the ops benches (p99 / soak / cold-boot): realistic mixed surface —
 * a bare route, a param route, a validated query, a validated JSON POST. */
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/", () => ({ hello: "world" }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .get("/search", { query: t.object({ q: t.string() }) }, (c) => ({ q: c.query.q, hits: 3 }))
  .post("/items", { body: t.object({ name: t.string(), qty: t.number() }) }, (c) => ({
    ok: true,
    name: c.body.name,
    qty: c.body.qty,
  }))

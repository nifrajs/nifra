import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { desc, eq } from "drizzle-orm"
import { db, ready } from "./db"
import { todos } from "./schema"

// nifra as a backend, with Drizzle + Postgres. nifra owns the HTTP boundary (routing, validation, the
// typed client); Drizzle owns the queries. No frontend. The `c.body`/`c.params` are validated before
// any query runs; Drizzle parameterizes every value.
await ready() // run migrations once on import

export const app = server()
  .get("/todos", async () => await db.select().from(todos).orderBy(desc(todos.id)))
  .get("/todos/:id", async (c) => {
    const id = Number(c.params.id)
    if (!Number.isInteger(id)) return new Response("Not found", { status: 404 })
    const [found] = await db.select().from(todos).where(eq(todos.id, id))
    return found ?? new Response("Not found", { status: 404 })
  })
  .post(
    "/todos",
    { body: t.object({ text: t.string({ minLength: 1, maxLength: 500 }) }) },
    async (c) => {
      const [row] = await db.insert(todos).values({ text: c.body.text }).returning()
      return row
    },
  )
  .post("/todos/:id/toggle", async (c) => {
    const id = Number(c.params.id)
    if (!Number.isInteger(id)) return new Response("Not found", { status: 404 })
    const [found] = await db.select().from(todos).where(eq(todos.id, id))
    if (!found) return new Response("Not found", { status: 404 })
    const [row] = await db
      .update(todos)
      .set({ done: !found.done })
      .where(eq(todos.id, id))
      .returning()
    return row
  })
  .delete("/todos/:id", async (c) => {
    const id = Number(c.params.id)
    if (!Number.isInteger(id)) return { deleted: false }
    const removed = await db.delete(todos).where(eq(todos.id, id)).returning({ id: todos.id })
    return { deleted: removed.length > 0 }
  })

export type App = typeof app

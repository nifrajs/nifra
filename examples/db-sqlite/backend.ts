import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { type Todo, todos } from "./db"

// A typed todos API backed by SQLite. nifra owns the HTTP boundary — routing, validation, and the
// end-to-end-typed client — while the database is plain `bun:sqlite`. Point `./db` at Postgres,
// Drizzle, or D1 and these routes don't change. No frontend: this is nifra used as a backend.
export const app = server()
  .get("/todos", (): Todo[] => todos.list())
  .get("/todos/:id", (c) => {
    const id = Number(c.params.id)
    const todo = Number.isInteger(id) ? todos.get(id) : null
    return todo ?? new Response("Not found", { status: 404 })
  })
  // The body is validated (1–500 chars) before the handler runs — invalid input never reaches the DB.
  .post("/todos", { body: t.object({ text: t.string({ minLength: 1, maxLength: 500 }) }) }, (c) =>
    todos.create(c.body.text),
  )
  .post("/todos/:id/toggle", (c) => {
    const id = Number(c.params.id)
    const todo = Number.isInteger(id) ? todos.toggle(id) : null
    return todo ?? new Response("Not found", { status: 404 })
  })
  .delete("/todos/:id", (c) => {
    const id = Number(c.params.id)
    return { deleted: Number.isInteger(id) ? todos.remove(id) : false }
  })

export type App = typeof app // import type { App } on the client for end-to-end types

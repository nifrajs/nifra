import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

// In-memory demo state — single-process example only, NOT a production pattern (a real app
// would use a shared store; see the global DB defaults).
let count = 0
let todos: Array<{ id: number; text: string }> = [{ id: 1, text: "learn nifra" }]
let nextTodoId = 2

/** The backend API (the contract source). Page loaders + actions call it via an in-process client. */
export const backend = server()
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
  .get("/todos", () => ({ todos }))
  .post("/todos", { body: t.object({ text: t.string({ minLength: 1, maxLength: 200 }) }) }, (c) => {
    const todo = { id: nextTodoId++, text: c.body.text }
    todos = [...todos, todo]
    return { todo }
  })
  // Per-row mutation (the concurrent-fetchers demo): append "!" to one todo by id.
  .post("/todos/bump", { body: t.object({ id: t.integer() }) }, (c) => {
    todos = todos.map((todo) => (todo.id === c.body.id ? { ...todo, text: `${todo.text}!` } : todo))
    return { ok: true }
  })

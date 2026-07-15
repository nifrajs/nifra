import { server } from "@nifrajs/core/server"

/** Your app. Exported (without `listen`) so tests can drive it via `app.fetch`. */
export const app = server()
  .get("/", () => ({ hello: "nifra" }))
  .get("/users/:id", (c) => ({ id: c.params.id }))

export type App = typeof app

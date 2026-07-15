/**
 * The simplest nifra server: inline routes, types inferred from the builder.
 *
 *   bun run examples/inline-server.ts
 */
import { server } from "@nifrajs/core/server"

const app = server()
  .get("/", () => ({ hello: "world" }))
  .get("/users/:id", (c) => ({ id: c.params.id }))

// `app.fetch(Request) -> Promise<Response>` runs the whole lifecycle without binding
// a port — handy for demos and tests. In production you'd `app.listen(3000)` instead.
const res = await app.fetch(new Request("http://localhost/users/42"))
console.log(res.status, await res.json()) // 200 { id: "42" }

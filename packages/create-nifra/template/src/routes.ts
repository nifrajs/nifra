import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

// Contract-first: the schema validates the body at the boundary, types `c.body` in the
// handler, types the response, and flows into the typed client (`testClient` in app.test.ts,
// `client<App>(baseUrl)` in a frontend) - no codegen step.
const EchoInput = t.object({ message: t.string({ minLength: 1 }) })
const EchoReply = t.object({ echoed: t.string() })

export const routes = server()
  .get("/", () => ({ hello: "nifra" }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/echo", { body: EchoInput, response: EchoReply }, (c) => ({ echoed: c.body.message }))

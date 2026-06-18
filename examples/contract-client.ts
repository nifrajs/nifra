/**
 * Contract-first + an end-to-end-typed client. The same handlers would work written
 * inline; the contract makes the API surface decoupled and versionable.
 *
 *   bun run examples/contract-client.ts
 */
import { client } from "@nifrajs/client"
import { defineContract, implement } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

const contract = defineContract({
  getUser: {
    method: "GET",
    path: "/users/:id",
    response: t.object({ id: t.string(), name: t.string() }),
  },
  createUser: {
    method: "POST",
    path: "/users",
    body: t.object({ name: t.string() }),
    response: t.object({ id: t.string(), name: t.string() }),
  },
})

const app = implement(contract, {
  getUser: (c) => ({ id: c.params.id, name: "ada" }),
  createUser: (c) => ({ id: "u-new", name: c.body.name }),
})

const instance = app.listen(0)
const api = client<typeof app>(`http://localhost:${instance.port}`)

const got = await api.users({ id: "42" }).get()
console.log("GET /users/42 ->", got.data) // { id: "42", name: "ada" }

const made = await api.users.post({ name: "Grace" })
console.log("POST /users   ->", made.data) // { id: "u-new", name: "Grace" }

instance.stop()

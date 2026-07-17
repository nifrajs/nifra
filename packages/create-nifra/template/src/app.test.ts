import { testClient } from "@nifrajs/client"
import { expect, test } from "bun:test"
import { app } from "./app.ts"

// The typed in-process client: no server, no port, the full real lifecycle (validation,
// middleware), and `res.data` typed from the route's schemas. Calls never throw - branch on `ok`.
const api = testClient<typeof app>(app)

test("GET /users/:id echoes the id", async () => {
  const res = await api.users({ id: "42" }).get()
  expect(res.ok).toBe(true)
  expect(res.data).toEqual({ id: "42" })
})

test("POST /echo round-trips a valid body", async () => {
  const res = await api.echo.post({ message: "hi" })
  expect(res.ok).toBe(true)
  expect(res.data).toEqual({ echoed: "hi" })
})

test("POST /echo rejects an invalid body at the boundary", async () => {
  const res = await api.echo.post({ message: "" })
  expect(res.ok).toBe(false)
  expect(res.status).toBe(422)
})

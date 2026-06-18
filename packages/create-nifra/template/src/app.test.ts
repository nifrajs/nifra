import { expect, test } from "bun:test"
import { app } from "./app.ts"

test("GET /users/:id echoes the id", async () => {
  const res = await app.fetch(new Request("http://localhost/users/42"))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ id: "42" })
})

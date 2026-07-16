import { describe, expect, test } from "bun:test"
import type { Context, StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { defineContract, implement } from "@nifrajs/core/contract"

function schema<O>(
  validate: (value: unknown) => StandardResult<O> | Promise<StandardResult<O>>,
): StandardSchemaV1<unknown, O> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, O>,
    },
  }
}

const nameBody = schema<{ name: string }>((v) =>
  typeof v === "object" && v !== null && "name" in v && typeof v.name === "string"
    ? { value: { name: v.name } }
    : { issues: [{ message: "name must be a string", path: ["name"] }] },
)
const pageQuery = schema<{ page: string }>((v) =>
  typeof v === "object" && v !== null && "page" in v && typeof v.page === "string"
    ? { value: { page: v.page } }
    : { issues: [{ message: "page is required", path: ["page"] }] },
)

// The SAME handler values are used by both modes — this is the graduation proof:
// lifting these into a contract requires no change to the handler bodies.
const listUsers = () => [{ id: "1" }]
const getUser = (c: Context<"/users/:id">) => ({ id: c.params.id })
const createUser = (c: Context<"/users", { body: typeof nameBody }>) => ({
  id: "1",
  name: c.body.name,
})
const search = (c: Context<"/search", { query: typeof pageQuery }>) => ({ page: c.query.page })

const inlineApp = server()
  .get("/users", listUsers)
  .get("/users/:id", getUser)
  .post("/users", { body: nameBody }, createUser)
  .get("/search", { query: pageQuery }, search)

const contract = defineContract({
  listUsers: { method: "GET", path: "/users" },
  getUser: { method: "GET", path: "/users/:id" },
  createUser: { method: "POST", path: "/users", body: nameBody },
  search: { method: "GET", path: "/search", query: pageQuery },
})
const contractApp = implement(contract, { listUsers, getUser, createUser, search })

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

const requests: ReadonlyArray<readonly [string, RequestInit?]> = [
  ["/users"],
  ["/users/42"],
  ["/search?page=7"],
  ["/search"], // 400 (missing query)
  ["/users", post({ name: "Ada" })],
  ["/users", post({ name: 123 })], // 400 (invalid body)
  ["/nope"], // 404
  ["/users", { method: "DELETE" }], // 405
]

describe("mode conformance — inline ≡ contract-first", () => {
  test("both servers respond identically to a shared request set", async () => {
    for (const [path, init] of requests) {
      const url = `http://localhost${path}`
      const [a, b] = await Promise.all([
        inlineApp.fetch(new Request(url, init)),
        contractApp.fetch(new Request(url, init)),
      ])
      expect(b.status).toBe(a.status)
      expect(await b.text()).toBe(await a.text())
    }
  })
})

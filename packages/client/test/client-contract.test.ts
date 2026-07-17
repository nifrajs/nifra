import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { TreatyFromRegistry } from "@nifrajs/client"
import { client } from "@nifrajs/client"
import type { Context, StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import { defineContract, implement, type RegistryFor } from "@nifrajs/core/contract"

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
    : { issues: [{ message: "name required", path: ["name"] }] },
)
// A response schema is the decoupled consumer's source of truth for the output type.
const userOut = schema<{ id: string; name: string }>((v) => ({
  value: v as { id: string; name: string },
}))
const notFoundError = schema<{ code: "not_found"; id: string }>((v) => ({
  value: v as { code: "not_found"; id: string },
}))

const contract = defineContract({
  getUser: { method: "GET", path: "/users/:id", response: userOut },
  createUser: { method: "POST", path: "/users", body: nameBody, response: userOut },
  // Declares a non-2xx error response — its schema types the decoupled client's failure `data`.
  getOrder: {
    method: "GET",
    path: "/orders/:id",
    responses: { "404": { schema: notFoundError } },
  },
})

const app = implement(contract, {
  getUser: (c: Context<"/users/:id">) => ({ id: c.params.id, name: "ada" }),
  createUser: (c: Context<"/users", { body: typeof nameBody }>) => ({
    id: "new",
    name: c.body.name,
  }),
  getOrder: (c: Context<"/orders/:id">) => {
    if (c.params.id === "missing") {
      return new Response(JSON.stringify({ code: "not_found", id: c.params.id }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    }
    return { orderId: c.params.id }
  },
})

let instance: ReturnType<typeof app.listen>
let api: TreatyFromRegistry<RegistryFor<typeof contract>>

beforeAll(() => {
  instance = app.listen(0)
  // Decoupled: typed entirely from the contract VALUE — no server import.
  api = client(contract, `http://localhost:${instance.port}`)
})
afterAll(() => {
  instance.stop()
})

describe("decoupled client — client(contract, url)", () => {
  test("GET round-trips, typed from the contract's response schema", async () => {
    const res = await api.users({ id: "5" }).get()
    expect(res.data).toEqual({ id: "5", name: "ada" })
    if (res.ok) {
      // compile-time: data is the response type, not unknown
      const id: string = res.data.id
      expect(id).toBe("5")
    }
  })

  test("POST round-trips with a validated body", async () => {
    const res = await api.users.post({ name: "Bob" })
    expect(res.data).toEqual({ id: "new", name: "Bob" })
  })

  test("invalid body is still rejected at the boundary (422)", async () => {
    // raw escape to send a bad body the typed client would forbid
    const raw = client(contract, `http://localhost:${instance.port}`) as unknown as {
      users: { post: (b: unknown) => Promise<{ ok: boolean; status: number }> }
    }
    const res = await raw.users.post({ name: 123 })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(422)
  })

  test("a contract op's non-2xx `responses` discriminate the failure `data` by status", async () => {
    const res = await api.orders({ id: "missing" }).get()
    expect(res.status).toBe(404)
    if (!res.ok && res.status === 404) {
      // compile-time: `status === 404` narrows `data` to THE declared 404 body from the
      // contract's `responses` — not a union of every error body.
      const code: "not_found" = res.data.code
      const id: string = res.data.id
      expect(code).toBe("not_found")
      expect(id).toBe("missing")
    } else {
      throw new Error("expected the declared 404 arm")
    }
  })
})

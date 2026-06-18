/**
 * Type-level proof that the decoupled client `client(contract, url)` types its
 * outputs from the contract's `response` schemas (the consumer's source of truth),
 * with no server import.
 */
import { client } from "@nifrajs/client"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { defineContract } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"

declare const userOut: StandardSchemaV1<unknown, { id: string; name: string }>
declare const nameBody: StandardSchemaV1<unknown, { name: string }>

const contract = defineContract({
  getUser: { method: "GET", path: "/users/:id", response: userOut },
  createUser: { method: "POST", path: "/users", body: nameBody, response: userOut },
  listUsers: { method: "GET", path: "/users" },
})

const api = client(contract, "http://localhost:3000")

type DataOf<P> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never

// output comes from the response schema
const byId = api.users({ id: "1" }).get()
export type _ById = Expect<Equal<DataOf<typeof byId>, { id: string; name: string }>>
const created = api.users.post({ name: "Ada" })
export type _Created = Expect<Equal<DataOf<typeof created>, { id: string; name: string }>>

// an op with no response schema → output is `unknown` (the consumer can't know it)
const listed = api.users.get()
export type _Listed = Expect<Equal<DataOf<typeof listed>, unknown>>

/**
 * Type-level mode conformance: the inline server's registry and the
 * contract-implemented server's registry are mutually assignable (interchangeable)
 * for equivalent routes + handlers. Strict `Equal` is a false-negative here
 * (inline builds by intersection, the contract by mapped type),
 * so mutual assignability is the correct check.
 */

import type { Context, Server, StandardSchemaV1 } from "@nifrajs/core"
import { defineContract, implement, server } from "@nifrajs/core"
import type { Expect } from "@nifrajs/test-utils"

declare const nameBody: StandardSchemaV1<unknown, { name: string }>

const listUsers = () => [{ id: "1" }]
const getUser = (c: Context<"/users/:id">) => ({ id: c.params.id })
const createUser = (c: Context<"/users", { body: typeof nameBody }>) => ({
  id: "1",
  name: c.body.name,
})

const inlineApp = server()
  .get("/users", listUsers)
  .get("/users/:id", getUser)
  .post("/users", { body: nameBody }, createUser)

const contract = defineContract({
  listUsers: { method: "GET", path: "/users" },
  getUser: { method: "GET", path: "/users/:id" },
  createUser: { method: "POST", path: "/users", body: nameBody },
})
// Graduation: the SAME handler values, lifted into implement unchanged.
const contractApp = implement(contract, { listUsers, getUser, createUser })

type RegOf<A> = A extends Server<infer R> ? R : never
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

export type _Conform = Expect<
  MutuallyAssignable<RegOf<typeof inlineApp>, RegOf<typeof contractApp>>
>

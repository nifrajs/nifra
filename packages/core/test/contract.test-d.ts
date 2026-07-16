import type { Registry, Server, StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import {
  type ContextForOp,
  defineContract,
  implement,
  type RegistryFor,
} from "@nifrajs/core/contract"
import type { Equal, Expect } from "@nifrajs/test-utils"

declare const name: StandardSchemaV1<unknown, { name: string }>
declare const page: StandardSchemaV1<unknown, { page: number }>
declare const user: StandardSchemaV1<unknown, { id: string; name: string }>

const contract = defineContract({
  getUser: { method: "GET", path: "/users/:id", response: user },
  listUsers: { method: "GET", path: "/users" },
  createUser: { method: "POST", path: "/users", body: name, response: user },
  replaceUser: { method: "PUT", path: "/users/:id", body: name },
  search: { method: "GET", path: "/search", query: page },
})
type C = typeof contract
type Reg = RegistryFor<C>

// `const` type param preserves path/method literals
export type _PathLiteral = Expect<Equal<C["getUser"]["path"], "/users/:id">>
export type _MethodLiteral = Expect<Equal<C["createUser"]["method"], "POST">>

// re-key: distinct paths, methods grouped per path
export type _Paths = Expect<Equal<keyof Reg, "/users/:id" | "/users" | "/search">>
export type _Methods = Expect<Equal<keyof Reg["/users/:id"], "GET" | "PUT">>

// fields derive from the op
export type _Params = Expect<Equal<Reg["/users/:id"]["GET"]["params"], { id: string }>>
export type _NoParams = Expect<Equal<keyof Reg["/users"]["GET"]["params"], never>>
export type _Body = Expect<Equal<Reg["/users"]["POST"]["body"], { name: string }>>
export type _NoBody = Expect<Equal<Reg["/users"]["GET"]["body"], never>>
export type _Query = Expect<Equal<Reg["/search"]["GET"]["query"], { page: number }>>

// output comes from the response schema, or `unknown` when none is declared
export type _Output = Expect<Equal<Reg["/users"]["POST"]["output"], { id: string; name: string }>>
export type _OutputUnknown = Expect<Equal<Reg["/users/:id"]["PUT"]["output"], unknown>>

// the contract registry is a valid Registry (so Server<RegistryFor<C>> works in 4b)
export type _IsRegistry = Expect<[Reg] extends [Registry] ? true : false>

// ContextForOp gives the handler the right body/params (the graduation guarantee)
export type _CtxBody = Expect<Equal<ContextForOp<C["createUser"]>["body"], { name: string }>>
export type _CtxParams = Expect<Equal<ContextForOp<C["getUser"]>["params"], { id: string }>>

// --- implement(): a contract's `response` constrains the backend handler + drives the implemented
// server's output, so a frontend built on `client(contract, …)` can't drift from the backend. ---
type RegistryOfServer<S> = S extends Server<infer R> ? R : never

const userContract = defineContract({
  getUser: { method: "GET", path: "/users/:id", response: user },
})

// The implemented server's output is the declared CONTRACT response — even though the handler returns a
// narrower literal — so it matches what `client(contract)` already sees (response wins, as inline).
const narrowApp = implement(userContract, {
  getUser: () => ({ id: "1" as const, name: "A" as const }),
})
export type _ImplResponseWins = Expect<
  Equal<
    RegistryOfServer<typeof narrowApp>["/users/:id"]["GET"]["output"],
    { id: string; name: string }
  >
>

// A handler whose return isn't assignable to the declared response is a COMPILE error (no drift).
implement(userContract, {
  // @ts-expect-error - returns { wrong: number }, not the declared { id: string; name: string }
  getUser: () => ({ wrong: 1 }),
})

// With NO declared response the output still comes from the handler (unchanged behavior).
const noRespApp = implement(defineContract({ ping: { method: "GET", path: "/ping" } }), {
  ping: () => ({ pong: true }),
})
export type _ImplNoResponseUsesHandler = Expect<
  Equal<RegistryOfServer<typeof noRespApp>["/ping"]["GET"]["output"], { pong: boolean }>
>

// ── implement(app): the contract's routes get the host app's middleware chain ────────────────────

// A route captures the server's derive/decorate chain AT REGISTRATION, so a contract-first app can
// only carry context if `implement` registers into an app that already has it.
const derived = server()
  .decorate("db", { find: (): { id: string } => ({ id: "u1" }) })
  .derive(() => ({ actor: "alice" }))

const ctxApp = implement(
  defineContract({ me: { method: "GET", path: "/me" } }),
  {
    me: (c) => ({ actor: c.actor, id: c.db.find().id }),
  },
  derived,
)

// The derived/decorated members are genuinely typed on the contract handler's context (not `any`):
// `c.actor` narrows to string, and the handler's return still drives the registry output.
implement(
  defineContract({ me: { method: "GET", path: "/me" } }),
  {
    me: (c) => {
      // @ts-expect-error - actor is string, so a number annotation must fail
      const wrong: number = c.actor
      return { wrong }
    },
  },
  derived,
)

export type _ImplCtxOutput = Expect<
  Equal<RegistryOfServer<typeof ctxApp>["/me"]["GET"]["output"], { actor: string; id: string }>
>

implement(
  defineContract({ me: { method: "GET", path: "/me" } }),
  {
    // @ts-expect-error - `missing` is not on the host app's derived context
    me: (c) => ({ x: c.missing }),
  },
  derived,
)

// Routes already on the host app survive alongside the contract's in the returned registry.
const hosted = implement(
  defineContract({ me: { method: "GET", path: "/me" } }),
  {
    me: () => ({ ok: true }),
  },
  server().get("/health", () => ({ up: true })),
)
export type _ImplKeepsHostRoutes = Expect<
  Equal<RegistryOfServer<typeof hosted>["/health"]["GET"]["output"], { up: boolean }>
>

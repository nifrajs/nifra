/**
 * Type-level contract for `Server.group`: the builder's routes land in the parent registry under the
 * joined path, with params, body, and output carried unchanged. Verified by `tsc`, not run.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { JoinRoutePath, PrefixRegistry, Server, StandardSchemaV1 } from "../src/index.ts"
import { server } from "../src/index.ts"

type RegistryOf<S> = S extends Server<infer R> ? R : never

declare const nameBody: StandardSchemaV1<{ name: string }, { name: string }>

const app = server()
  .derive(() => ({ tenant: "t1" }))
  .get("/health", () => ({ ok: true }))
  .group("/api", (api) =>
    api
      // The inherited context is visible inside the builder.
      .get("/", (c) => ({ tenant: c.tenant }))
      .get("/users/:id", (c) => ({ id: c.params.id }))
      .post("/users", { body: nameBody }, (c) => ({ created: c.body.name }))
      .group("/v1", (v1) => v1.get("/orders/:orderId", (c) => ({ order: c.params.orderId }))),
  )
  // The parent's own context is unchanged after the group.
  .get("/after", (c) => ({ tenant: c.tenant }))

type Reg = RegistryOf<typeof app>

export type _Keys = Expect<
  Equal<
    keyof Reg,
    "/health" | "/api" | "/api/users/:id" | "/api/users" | "/api/v1/orders/:orderId" | "/after"
  >
>
export type _RootIsPrefix = Expect<Equal<Reg["/api"]["GET"]["output"], { tenant: string }>>
export type _Params = Expect<Equal<Reg["/api/users/:id"]["GET"]["params"], { id: string }>>
export type _Body = Expect<Equal<Reg["/api/users"]["POST"]["body"], { name: string }>>
export type _Output = Expect<Equal<Reg["/api/users"]["POST"]["output"], { created: string }>>
export type _Nested = Expect<
  Equal<Reg["/api/v1/orders/:orderId"]["GET"]["params"], { orderId: string }>
>

export type _Join = Expect<Equal<JoinRoutePath<"/api", "/">, "/api">>
export type _JoinPath = Expect<Equal<JoinRoutePath<"/api", "/x/:id">, "/api/x/:id">>
export type _PrefixEmpty = Expect<Equal<keyof PrefixRegistry<"/api", NonNullable<unknown>>, never>>

// The builder's scope is typed with the parent's context, not the group's registry leaking back.
server().group("/g", (g) =>
  // @ts-expect-error - `nope` is not on the inherited context
  g.get("/x", (c) => c.nope),
)

/** Type-level contract for optional route params. Checked by `tsc`, not run. */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { Params, Server, StandardSchemaV1 } from "../src/index.ts"
import { server } from "../src/index.ts"
import type { RoutePaths } from "../src/server/context.ts"
import { defineContract, implement, type RegistryFor } from "../src/server/contract.ts"

type RegistryOf<S> = S extends Server<infer R> ? R : never

declare const nameBody: StandardSchemaV1<{ name: string }, { name: string }>

// --- Params ---------------------------------------------------------------------------------
export type _One = Expect<Equal<Params<"/users/:id?">, { id?: string }>>
export type _Required = Expect<Equal<Params<"/orgs/:org/users/:id?">, { org: string; id?: string }>>
export type _Run = Expect<
  Equal<Params<"/d/:year?/:month?/:day?">, { year?: string; month?: string; day?: string }>
>
export type _Root = Expect<Equal<Params<"/:lang?">, { lang?: string }>>
// A `?` that is not part of a trailing run of whole segments is ordinary text.
export type _NotTrailing = Expect<Equal<Params<"/a/:id?/b">, { id: string }>>
export type _OnlyTrailingRun = Expect<Equal<Params<"/a/:x?/b/:y?">, { x: string; y?: string }>>
export type _Unchanged = Expect<Equal<Params<"/users/:id">, { id: string }>>
export type _Wide = Expect<Equal<Params<string>, Record<string, string>>>

// --- RoutePaths -----------------------------------------------------------------------------
export type _Forms = Expect<Equal<RoutePaths<"/users/:id?">, "/users" | "/users/:id">>
export type _RunForms = Expect<Equal<RoutePaths<"/d/:y?/:m?">, "/d" | "/d/:y" | "/d/:y/:m">>
export type _RootForms = Expect<Equal<RoutePaths<"/:lang?">, "/" | "/:lang">>
export type _RequiredForms = Expect<
  Equal<RoutePaths<"/orgs/:org/users/:id?">, "/orgs/:org/users" | "/orgs/:org/users/:id">
>
export type _NotTrailingForms = Expect<Equal<RoutePaths<"/a/:id?/b">, "/a/:id?/b">>
export type _MixedForms = Expect<Equal<RoutePaths<"/a/x-:id?">, "/a/x-:id?">>
export type _PlainForms = Expect<Equal<RoutePaths<"/users/:id">, "/users/:id">>
export type _WideForms = Expect<Equal<RoutePaths<string>, string>>

// --- the fluent registry --------------------------------------------------------------------
const app = server()
  .get("/users/:id?", (c) => {
    const id: string | undefined = c.params.id
    // @ts-expect-error - the param may be absent, so it is not a plain string
    const required: string = c.params.id
    return { id, required }
  })
  .post("/d/:year?/:month?", { body: nameBody }, (c) => ({
    year: c.params.year,
    month: c.params.month,
    name: c.body.name,
  }))
  .group("/api", (api) => api.get("/items/:item?", (c) => ({ item: c.params.item })))
  .get("/:lang?", (c) => ({ lang: c.params.lang }))

type Reg = RegistryOf<typeof app>

export type _Keys = Expect<
  Equal<
    keyof Reg,
    | "/users"
    | "/users/:id"
    | "/d"
    | "/d/:year"
    | "/d/:year/:month"
    | "/api/items"
    | "/api/items/:item"
    | "/"
    | "/:lang"
  >
>
// Every form carries the one route's info.
export type _ShortOutput = Expect<
  Equal<Reg["/users"]["GET"]["output"], Reg["/users/:id"]["GET"]["output"]>
>
export type _Body = Expect<Equal<Reg["/d/:year"]["POST"]["body"], { name: string }>>
export type _Grouped = Expect<
  Equal<Reg["/api/items"]["GET"]["output"], { item: string | undefined }>
>
export type _RootOutput = Expect<Equal<Reg["/"]["GET"]["output"], { lang: string | undefined }>>

// --- a contract -----------------------------------------------------------------------------
declare const user: StandardSchemaV1<unknown, { id: string }>

const contract = defineContract({
  user: { method: "GET", path: "/users/:id?", response: user },
  remove: { method: "DELETE", path: "/users/:id" },
})
type ContractReg = RegistryFor<typeof contract>

export type _ContractKeys = Expect<Equal<keyof ContractReg, "/users" | "/users/:id">>
export type _ContractShort = Expect<Equal<keyof ContractReg["/users"], "GET">>
export type _ContractLong = Expect<Equal<keyof ContractReg["/users/:id"], "GET" | "DELETE">>
export type _ContractOutput = Expect<Equal<ContractReg["/users"]["GET"]["output"], { id: string }>>

const implemented = implement(contract, {
  user: (c) => ({ id: c.params.id ?? "all" }),
  remove: (c) => ({ id: c.params.id }),
})
export type _ImplementedKeys = Expect<
  Equal<keyof RegistryOf<typeof implemented>, "/users" | "/users/:id">
>

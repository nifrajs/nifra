/**
 * Type-level contract for constrained route params: a constraint narrows what the router accepts and
 * leaves the param a `string`, keyed by its bare name. Verified by `tsc`, not run.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { Params, Server } from "../src/index.ts"
import { server } from "../src/index.ts"
import type { RoutePaths } from "../src/server/context.ts"

type RegistryOf<S> = S extends Server<infer R> ? R : never

// --- Params ---------------------------------------------------------------------------------
export type _Class = Expect<Equal<Params<"/users/:id{[0-9]+}">, { id: string }>>
export type _Counted = Expect<Equal<Params<"/c/:code{[A-Z]{2,3}}">, { code: string }>>
export type _Escape = Expect<Equal<Params<"/p/:pin{\\d{4}}">, { pin: string }>>
export type _List = Expect<Equal<Params<"/l/:lang{en|fr|de}">, { lang: string }>>
export type _Middle = Expect<
  Equal<Params<"/orgs/:org{[a-z]+}/users/:id">, { org: string; id: string }>
>
export type _InSegment = Expect<
  Equal<Params<"/f/:name.:ext{png|jpg}">, { name: string; ext: string }>
>
export type _Pair = Expect<Equal<Params<"/d/:y{\\d{4}}-:m{\\d{2}}">, { y: string; m: string }>>
export type _Wildcard = Expect<
  Equal<Params<"/v/:major{[0-9]+}/*rest">, { major: string; rest: string }>
>

// --- optional -------------------------------------------------------------------------------
export type _Optional = Expect<Equal<Params<"/o/:id{[0-9]+}?">, { id?: string }>>
export type _OptionalCounted = Expect<Equal<Params<"/o/:code{[A-Z]{2}}?">, { code?: string }>>
export type _OptionalRun = Expect<
  Equal<Params<"/d/:y{\\d{4}}?/:m{\\d{2}}?/:page?">, { y?: string; m?: string; page?: string }>
>
export type _RequiredThenOptional = Expect<
  Equal<Params<"/l/:lang{en|fr}/:page{[0-9]+}?">, { lang: string; page?: string }>
>

// --- RoutePaths -----------------------------------------------------------------------------
export type _PlainForm = Expect<Equal<RoutePaths<"/users/:id{[0-9]+}">, "/users/:id{[0-9]+}">>
export type _Forms = Expect<Equal<RoutePaths<"/o/:id{[0-9]+}?">, "/o" | "/o/:id{[0-9]+}">>
export type _CountedForms = Expect<
  Equal<RoutePaths<"/o/:code{[A-Z]{2}}?">, "/o" | "/o/:code{[A-Z]{2}}">
>
export type _RunForms = Expect<
  Equal<
    RoutePaths<"/d/:y{\\d{4}}?/:m{\\d{2}}?">,
    "/d" | "/d/:y{\\d{4}}" | "/d/:y{\\d{4}}/:m{\\d{2}}"
  >
>
export type _ListForms = Expect<
  Equal<RoutePaths<"/l/:lang{en|fr}?/:page?">, "/l" | "/l/:lang{en|fr}" | "/l/:lang{en|fr}/:page">
>
// A `?` inside the segment, or after text that follows the constraint, is not an optional param.
export type _NotOptional = Expect<Equal<RoutePaths<"/o/:id{[0-9]+}x?">, "/o/:id{[0-9]+}x?">>

// --- the fluent registry --------------------------------------------------------------------
const app = server()
  .get("/users/:id{[0-9]+}", (c) => {
    const id: string = c.params.id
    // @ts-expect-error - the constraint is not part of the name
    c.params["id{[0-9]+}"]
    return { id }
  })
  // nifra-expect route-overlap: prove a constrained and a bare parameter keep separate registry keys.
  .get("/users/:name", (c) => ({ name: c.params.name }))
  .get("/o/:page{[0-9]+}?", (c) => {
    const page: string | undefined = c.params.page
    // @ts-expect-error - the param may be absent
    const required: string = c.params.page
    return { page, required }
  })
  .group("/img", (img) => img.get("/:kind{thumb|full}", (c) => ({ kind: c.params.kind })))

type Reg = RegistryOf<typeof app>

export type _Keys = Expect<
  Equal<
    keyof Reg,
    "/users/:id{[0-9]+}" | "/users/:name" | "/o" | "/o/:page{[0-9]+}" | "/img/:kind{thumb|full}"
  >
>
export type _Output = Expect<Equal<Reg["/users/:id{[0-9]+}"]["GET"]["output"], { id: string }>>
export type _Grouped = Expect<
  Equal<Reg["/img/:kind{thumb|full}"]["GET"]["output"], { kind: string }>
>

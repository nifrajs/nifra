/**
 * Type-level proof that `Server` accumulates every route into its type (3a).
 * Verified by `tsc`. The ~14-route app also exercises instantiation depth - if
 * accumulation blew up ("excessively deep"), this file would fail to compile.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { Server, StandardSchemaV1 } from "../src/index.ts"
import { server } from "../src/index.ts"

type RegistryOf<S> = S extends Server<infer R> ? R : never

// Declared (type-only) schemas - this file never runs. Input and output sides are declared
// separately because the registry surfaces the INPUT side for `body`/`query` (what a caller sends)
// and the OUTPUT side for handler-facing types.
declare const nameBody: StandardSchemaV1<{ name: string }, { name: string }>
declare const pageQuery: StandardSchemaV1<{ page: number }, { page: number }>

const app = server()
  .get("/health", () => ({ ok: true }))
  .get("/version", () => ({ version: "1" }))
  .get("/users", () => [{ id: "1" }])
  .post("/users", { body: nameBody }, (c) => ({ id: "1", name: c.body.name }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .put("/users/:id", { body: nameBody }, (c) => ({ id: c.params.id, name: c.body.name }))
  .delete("/users/:id", (c) => ({ deleted: c.params.id }))
  .get("/users/:id/posts", () => [{ pid: "1" }])
  .get("/users/:id/posts/:postId", (c) => ({ id: c.params.id, postId: c.params.postId }))
  .post("/users/:id/posts", { body: nameBody }, (c) => ({ id: c.params.id }))
  .get("/posts", () => [{ slug: "x" }])
  .get("/posts/:slug", (c) => ({ slug: c.params.slug }))
  .get("/search", { query: pageQuery }, (c) => ({ page: c.query.page }))
  .get("/a/b/c/d/e", () => ({ deep: true }))

type Reg = RegistryOf<typeof app>

// --- output capture (the handler's return type flows into the registry) ---
export type _OutGetUser = Expect<Equal<Reg["/users/:id"]["GET"]["output"], { id: string }>>
export type _OutPostUser = Expect<
  Equal<Reg["/users"]["POST"]["output"], { id: string; name: string }>
>
export type _OutList = Expect<Equal<Reg["/users"]["GET"]["output"], { id: string }[]>>

// --- params captured from the path ---
export type _ParamsOne = Expect<Equal<Reg["/users/:id"]["GET"]["params"], { id: string }>>
export type _ParamsNested = Expect<
  Equal<Reg["/users/:id/posts/:postId"]["GET"]["params"], { id: string; postId: string }>
>
export type _ParamsNone = Expect<Equal<keyof Reg["/users"]["GET"]["params"], never>>

// --- body: the schema's INPUT (wire) side, or `never` when none ---
export type _BodyPost = Expect<Equal<Reg["/users"]["POST"]["body"], { name: string }>>
export type _BodyNone = Expect<Equal<Reg["/users"]["GET"]["body"], never>>

// --- query: the schema's INPUT (wire) side, or `never` when none ---
export type _Query = Expect<Equal<Reg["/search"]["GET"]["query"], { page: number }>>
export type _QueryNone = Expect<Equal<Reg["/health"]["GET"]["query"], never>>

// --- a defaulting/transforming schema: the registry's body/query is the PRE-validation input shape
// (what a caller must send), not the parsed output - a `.default()`ed field stays optional for the
// caller even though the handler always receives it. ---
declare const draftBody: StandardSchemaV1<
  { title: string; tags?: string[] },
  { title: string; tags: string[] }
>
const draftApp = server().post("/drafts", { body: draftBody }, (c) => ({ n: c.body.tags.length }))
export type _BodyIsInputSide = Expect<
  Equal<RegistryOf<typeof draftApp>["/drafts"]["POST"]["body"], { title: string; tags?: string[] }>
>

// --- multiple methods on one path merge under that path ---
export type _Methods = Expect<Equal<keyof Reg["/users/:id"], "GET" | "PUT" | "DELETE">>

// --- the path set is complete ---
export type _Paths = Expect<
  Equal<
    keyof Reg,
    | "/health"
    | "/version"
    | "/users"
    | "/users/:id"
    | "/users/:id/posts"
    | "/users/:id/posts/:postId"
    | "/posts"
    | "/posts/:slug"
    | "/search"
    | "/a/b/c/d/e"
  >
>

// --- declared `response` schema: the CONTRACT drives the client's output type and constrains the
// handler, so the implementation can't drift from the contract the client (frontend) consumes. ---
declare const idOnly: StandardSchemaV1<unknown, { id: string }>

// The handler returns the narrower literal `{ id: "always-1" }`, but the client-visible output is the
// declared contract `{ id: string }` - proving the response schema wins over the inferred return.
const contractApp = server().get("/c", { response: idOnly }, () => ({ id: "always-1" as const }))
export type _ResponseContractWins = Expect<
  Equal<RegistryOf<typeof contractApp>["/c"]["GET"]["output"], { id: string }>
>

// A handler whose return isn't assignable to the declared response is a compile error (no drift).
server().get(
  "/bad",
  { response: idOnly },
  // @ts-expect-error - returns { wrong: number }, not the declared { id: string }
  () => ({ wrong: 1 }),
)

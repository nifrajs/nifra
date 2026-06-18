import type { Treaty } from "@nifrajs/client"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
/**
 * The air-tight gate for the Eden-style proxy type. Verified by `tsc`. A ~25-route
 * app exercises instantiation depth; correct calls assert input/output inference
 * (including `Jsonify`, root `index`, and wildcards); misuse `@ts-expect-error`s
 * assert the type rejects bad calls.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"

declare const name: StandardSchemaV1<unknown, { name: string }>
declare const page: StandardSchemaV1<unknown, { page: number }>
declare const creds: StandardSchemaV1<unknown, { email: string; password: string }>

const app = server()
  .get("/", () => ({ root: true }))
  .get("/health", () => ({ ok: true }))
  .get("/version", () => ({ v: "1" }))
  .get("/now", () => ({ at: new Date() }))
  .get("/files/*path", (c) => ({ path: c.params.path }))
  .get("/search", { query: page }, (c) => ({ page: c.query.page }))
  .get("/users", () => [{ id: "1" }])
  .post("/users", { body: name }, (c) => ({ id: "1", name: c.body.name }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .put("/users/:id", { body: name }, (c) => ({ id: c.params.id, name: c.body.name }))
  .delete("/users/:id", (c) => ({ deleted: c.params.id }))
  .get("/users/:id/posts", () => [{ pid: "1" }])
  .post("/users/:id/posts", { body: name }, (c) => ({ id: c.params.id }))
  .get("/users/:id/posts/:postId", (c) => ({ id: c.params.id, postId: c.params.postId }))
  .get("/posts", () => [{ slug: "x" }])
  .get("/posts/:slug", (c) => ({ slug: c.params.slug }))
  .get("/orders", () => [{ id: "1" }])
  .get("/orders/:id", (c) => ({ id: c.params.id }))
  .get("/orders/:id/items", () => [{ iid: "1" }])
  .get("/orders/:id/items/:itemId", (c) => ({ id: c.params.id, itemId: c.params.itemId }))
  .get("/admin/users", () => [{ id: "1" }])
  .get("/admin/users/:id", (c) => ({ id: c.params.id }))
  .get("/a/b/c/d", () => ({ deep: true }))
  .post("/auth/login", { body: creds }, () => ({ token: "t" }))
  .post("/ping", () => ({ pong: true }))
  // A `/v1/*` group exercising the user-reported failures: a segment that is BOTH a GET leaf and a
  // namespace (`/v1/me` + `/v1/me/results`), and a wide static group alongside it (`/v1/destinations…`).
  .get("/v1/me", () => ({ id: "1" }))
  .get("/v1/me/results", () => [{ r: 1 }])
  .get("/v1/destinations", () => [{ id: "1" }])
  .get("/v1/destinations/:id", (c) => ({ id: c.params.id }))
  .get("/v1/trips", () => [{ id: "1" }])

type App = typeof app
declare const api: Treaty<App>

type DataOf<P> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never

// --- correct usage: input shape + output inference ---
export type _List = Expect<Equal<DataOf<ReturnType<typeof api.users.get>>, { id: string }[]>>

const byId = api.users({ id: "1" }).get()
export type _ById = Expect<Equal<DataOf<typeof byId>, { id: string }>>

const created = api.users.post({ name: "Ada" })
export type _Created = Expect<Equal<DataOf<typeof created>, { id: string; name: string }>>

const nested = api.users({ id: "1" }).posts({ postId: "2" }).get()
export type _Nested = Expect<Equal<DataOf<typeof nested>, { id: string; postId: string }>>

const deepOrder = api.orders({ id: "1" }).items({ itemId: "9" }).get()
export type _DeepOrder = Expect<Equal<DataOf<typeof deepOrder>, { id: string; itemId: string }>>

const root = api.index.get() // GET /
export type _Root = Expect<Equal<DataOf<typeof root>, { root: boolean }>>

const wild = api.files({ path: "a/b/c.txt" }).get() // wildcard param
export type _Wild = Expect<Equal<DataOf<typeof wild>, { path: string }>>

const searched = api.search.get({ query: { page: 2 } }) // typed query
export type _Search = Expect<Equal<DataOf<typeof searched>, { page: number }>>

const now = api.now.get() // Jsonify: Date -> string
export type _Now = Expect<Equal<DataOf<typeof now>, { at: string }>>

const nestedStatic = api.admin.users.get() // nested static segments
export type _AdminList = Expect<Equal<DataOf<typeof nestedStatic>, { id: string }[]>>

const pinged = api.ping.post() // bodyless body-verb: body optional, options still allowed
export type _Ping = Expect<Equal<DataOf<typeof pinged>, { pong: boolean }>>

// leaf-vs-branch: `me` is both a GET leaf AND a namespace with a `results` child (user-reported (d)).
const me = api.v1.me.get()
export type _Me = Expect<Equal<DataOf<typeof me>, { id: string }>>
const meResults = api.v1.me.results.get()
export type _MeResults = Expect<Equal<DataOf<typeof meResults>, { r: number }[]>>
// wide static group under the same prefix resolves (user-reported (b): `api.v1.destinations` etc.).
const dests = api.v1.destinations.get()
export type _Dests = Expect<Equal<DataOf<typeof dests>, { id: string }[]>>
const dest = api.v1.destinations({ id: "1" }).get()
export type _Dest = Expect<Equal<DataOf<typeof dest>, { id: string }>>
const trips = api.v1.trips.get()
export type _Trips = Expect<Equal<DataOf<typeof trips>, { id: string }[]>>

// --- misuse must be rejected ---
// @ts-expect-error unknown segment
api.nope.get()
// @ts-expect-error wrong param key
api.users({ wrong: "1" }).get()
// @ts-expect-error POST requires a body
api.users.post()
// @ts-expect-error wrong body shape
api.users.post({ nope: 1 })
// @ts-expect-error method the route doesn't define (only GET/PUT/DELETE)
api.users({ id: "1" }).patch()
// @ts-expect-error query shape is wrong
api.search.get({ query: { page: "two" } })
// @ts-expect-error a bodyless POST takes no body argument
api.ping.post({ data: 1 })

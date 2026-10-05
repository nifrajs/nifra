/**
 * The typed client over a route with optional params: each concrete path the route serves is
 * callable, with the param given or left out. Verified by `tsc`, not run.
 */
import type { Treaty } from "@nifrajs/client"
import { client as contractClient } from "@nifrajs/client"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { defineContract } from "@nifrajs/core/contract"
import type { Equal, Expect } from "@nifrajs/test-utils"

declare const name: StandardSchemaV1<{ name: string }, { name: string }>
declare const userOut: StandardSchemaV1<unknown, { id: string }>

const app = server()
  .get("/users/:id?", (c) => ({ id: c.params.id ?? "all" }))
  .post("/d/:year?/:month?", { body: name }, (c) => ({ year: c.params.year ?? "", n: c.body.name }))
  // nifra-expect route-overlap: the root optional parameter intentionally shares /users.
  .get("/:lang?", (c) => ({ lang: c.params.lang ?? "en" }))

declare const client: Treaty<typeof app>

type DataOf<P> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never

const all = client.users.get()
export type _All = Expect<Equal<DataOf<typeof all>, { id: string }>>
const one = client.users({ id: "1" }).get()
export type _One = Expect<Equal<DataOf<typeof one>, { id: string }>>

const none = client.d.post({ name: "a" })
export type _None = Expect<Equal<DataOf<typeof none>, { year: string; n: string }>>
const year = client.d({ year: "2026" }).post({ name: "a" })
export type _Year = Expect<Equal<DataOf<typeof year>, { year: string; n: string }>>
const month = client.d({ year: "2026" })({ month: "09" }).post({ name: "a" })
export type _Month = Expect<Equal<DataOf<typeof month>, { year: string; n: string }>>

const rootless = client.index.get()
export type _Rootless = Expect<Equal<DataOf<typeof rootless>, { lang: string }>>
const lang = client({ lang: "fr" }).get()
export type _Lang = Expect<Equal<DataOf<typeof lang>, { lang: string }>>

// @ts-expect-error - the body schema applies to every form
client.d({ year: "2026" }).post({ nope: 1 })
// @ts-expect-error - the param key is the declared name
client.users({ nope: "1" }).get()

const contract = defineContract({
  user: { method: "GET", path: "/users/:id?", response: userOut },
})
const api = contractClient(contract, "http://localhost:3000")

const listed = api.users.get()
export type _Listed = Expect<Equal<DataOf<typeof listed>, { id: string }>>
const byId = api.users({ id: "1" }).get()
export type _ById = Expect<Equal<DataOf<typeof byId>, { id: string }>>

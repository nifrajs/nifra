/**
 * The typed client over `Server.group` routes: the prefix is part of every path, exactly as the
 * server serves it. Verified by `tsc`, not run.
 */
import type { Treaty } from "@nifrajs/client"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"

declare const name: StandardSchemaV1<{ name: string }, { name: string }>

const app = server()
  .get("/health", () => ({ ok: true }))
  .group("/api", (api) =>
    api
      .get("/", () => ({ root: true }))
      .get("/users/:id", (c) => ({ id: c.params.id }))
      .post("/users", { body: name }, (c) => ({ created: c.body.name }))
      .group("/v1", (v1) => v1.get("/me", () => ({ me: "1" }))),
  )

declare const client: Treaty<typeof app>

type DataOf<P> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never

const root = client.api.get()
export type _Root = Expect<Equal<DataOf<typeof root>, { root: boolean }>>
const user = client.api.users({ id: "1" }).get()
export type _User = Expect<Equal<DataOf<typeof user>, { id: string }>>
const created = client.api.users.post({ name: "ada" })
export type _Created = Expect<Equal<DataOf<typeof created>, { created: string }>>
const me = client.api.v1.me.get()
export type _Me = Expect<Equal<DataOf<typeof me>, { me: string }>>

// @ts-expect-error - the unprefixed path was never registered
client.users({ id: "1" }).get()
// @ts-expect-error - the body schema still applies under the prefix
client.api.users.post({ nope: 1 })

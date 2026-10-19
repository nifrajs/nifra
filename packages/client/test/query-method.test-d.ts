/**
 * A QUERY route is called as `$query(body)`, its body positional like POST's, and `query` stays a
 * path segment. Verified by `tsc`, not run.
 */
import type { Treaty } from "@nifrajs/client"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { method } from "@nifrajs/core/methods"
import type { Equal, Expect } from "@nifrajs/test-utils"

declare const filter: StandardSchemaV1<{ q: string }, { q: string }>

const app = server()
  .use(method("QUERY", "/books", { body: filter }, (c) => ({ found: [c.body.q] })))
  .get("/books/query", () => ({ via: "path" }))

declare const client: Treaty<typeof app>

type DataOf<P> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never

const found = client.books.$query({ q: "nifra" }, { headers: { "x-a": "1" } })
export type _Found = Expect<Equal<DataOf<typeof found>, { found: string[] }>>
// @ts-expect-error the route declares a body, so the call must send one
void client.books.$query()
// @ts-expect-error the body is checked against the route's schema
void client.books.$query({ q: 1 })
// `query` is a path segment, not a verb.
const viaPath = client.books.query.get()
export type _ViaPath = Expect<Equal<DataOf<typeof viaPath>, { via: string }>>

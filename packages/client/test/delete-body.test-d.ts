/**
 * A DELETE whose route declares a body schema takes it as `options.body`; one without keeps its
 * bodyless options. Verified by `tsc`, not run.
 */
import type { Treaty } from "@nifrajs/client"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"

declare const ids: StandardSchemaV1<{ ids: string[] }, { ids: string[] }>

const app = server()
  .delete("/items", { body: ids }, (c) => ({ deleted: c.body.ids.length }))
  .delete("/plain", () => ({ ok: true }))

declare const client: Treaty<typeof app>

type DataOf<P> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never

const removed = client.items.delete({ body: { ids: ["a"] }, headers: { "x-a": "1" } })
export type _Removed = Expect<Equal<DataOf<typeof removed>, { deleted: number }>>
// @ts-expect-error the route declares a body, so the call must send one
void client.items.delete()
// @ts-expect-error the body is checked against the route's schema
void client.items.delete({ body: { ids: [1] } })

const plain = client.plain.delete()
export type _Plain = Expect<Equal<DataOf<typeof plain>, { ok: boolean }>>
// @ts-expect-error a route without a body schema takes no body
void client.plain.delete({ body: {} })

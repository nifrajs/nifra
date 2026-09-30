import type { Treaty } from "@nifrajs/client"
import { server } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"

/**
 * A segment that is part literal, part parameter is called with the segment as the request carries
 * it. Verified by `tsc`.
 */
const app = server()
  .get("/files/:name.json", (c) => ({ json: c.params.name }))
  .get("/files/:name.csv", (c) => ({ csv: c.params.name }))
  .get("/files/index.json", () => ({ index: true }))
  .get("/files/:id", (c) => ({ plain: c.params.id }))
  .get("/post-:id", (c) => ({ post: c.params.id }))
  .get("/post-:id/comments", () => [{ cid: "1" }])
  .get("/v:major.:minor", (c) => ({ major: c.params.major, minor: c.params.minor }))
  .get("/img/:id{[0-9]+}.png", (c) => ({ img: c.params.id }))
  .get("/pair/:a{x|y}-:b{[0-9]+}", (c) => ({ a: c.params.a, b: c.params.b }))
  .get("/things:batchGet", () => ({ batch: true }))
  .get("/reports/:year{[0-9]{4}}-summary", (c) => ({ year: c.params.year }))

declare const api: Treaty<typeof app>

type DataOf<P> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never

const json = api.files("report.json").get()
export type _Json = Expect<Equal<DataOf<typeof json>, { json: string }>>
const csv = api.files("report.csv").get()
export type _Csv = Expect<Equal<DataOf<typeof csv>, { csv: string }>>

// A value built at runtime keeps the literal text in its type.
declare const stem: string
const built = api.files(`${stem}.json`).get()
export type _Built = Expect<Equal<DataOf<typeof built>, { json: string }>>

// A static sibling is picked for its exact text, as the server picks it.
const index = api.files("index.json").get()
export type _StaticFirst = Expect<Equal<DataOf<typeof index>, { index: boolean }>>
export type _StaticProperty = Expect<
  Equal<DataOf<ReturnType<(typeof api.files)["index.json"]["get"]>>, { index: boolean }>
>

// A whole-segment param at the same position is still called with its name.
const plain = api.files({ id: "7" }).get()
export type _WholeParam = Expect<Equal<DataOf<typeof plain>, { plain: string }>>

// A literal prefix, and children below a mixed segment.
const post = api("post-42").get()
export type _Prefix = Expect<Equal<DataOf<typeof post>, { post: string }>>
const comments = api("post-42").comments.get()
export type _Below = Expect<Equal<DataOf<typeof comments>, { cid: string }[]>>

// Several params in one segment.
const version = api("v1.2").get()
export type _TwoParams = Expect<Equal<DataOf<typeof version>, { major: string; minor: string }>>

// A constraint is not part of the text.
const img = api.img("7.png").get()
export type _Constrained = Expect<Equal<DataOf<typeof img>, { img: string }>>
const pair = api.pair("x-1").get()
export type _ConstrainedPair = Expect<Equal<DataOf<typeof pair>, { a: string; b: string }>>
const summary = api.reports("2026-summary").get()
export type _CountedConstraint = Expect<Equal<DataOf<typeof summary>, { year: string }>>

// A colon that is literal text stays a static segment.
const batch = api["things:batchGet"].get()
export type _LiteralColon = Expect<Equal<DataOf<typeof batch>, { batch: boolean }>>

// @ts-expect-error no route at this position ends in `.txt`
api.files("report.txt")
// @ts-expect-error a mixed segment has no param name to call by
api.files({ "name.json": "report" })
// @ts-expect-error the segment is not a property: that spelling would send the pattern itself
api["post-:id"]
// @ts-expect-error the literal text is required
api.img("7")
// @ts-expect-error the `.json` route has no `comments` child
api.files("report.json").comments

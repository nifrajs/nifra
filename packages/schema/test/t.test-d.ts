/**
 * Type-level contract for `t`: each constructor's inferred output type, and - the
 * payoff - that a `t` schema flows into `c.body` through `@nifrajs/core`'s existing
 * validation path with no special-casing. Verified by `tsc --noEmit`.
 */

import type { Context, InferOutput } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"
import { t as formT } from "../src/form.ts"
import { t } from "../src/index.ts"

const str = t.string()
const user = t.object({ name: t.string(), age: t.number() })
const withOptional = t.object({ name: t.string(), nick: t.optional(t.string()) })
const list = t.array(t.string())
const either = t.union([t.string(), t.number()])
const lit = t.literal("active")

export type _String = Expect<Equal<InferOutput<typeof str>, string>>
export type _Object = Expect<Equal<InferOutput<typeof user>, { name: string; age: number }>>
export type _Optional = Expect<
  Equal<InferOutput<typeof withOptional>, { name: string; nick?: string }>
>
export type _Array = Expect<Equal<InferOutput<typeof list>, string[]>>
export type _Union = Expect<Equal<InferOutput<typeof either>, string | number>>
export type _Literal = Expect<Equal<InferOutput<typeof lit>, "active">>

// The payoff: a `t` schema as a route body types `c.body` end-to-end - asserted on
// `Context` (exactly what the handler receives), and proven to compile through
// `server().post`.
export type _BodyFlow = Expect<
  Equal<Context<"/users", { body: typeof user }>["body"], { name: string; age: number }>
>
const app = server().post("/users", { body: user }, (c) => c.body)
export type _App = typeof app

// Files: the `t` of `@nifrajs/schema/form` adds `t.file` (a `File`) and `t.form`, which types text and
// file fields side by side and is a route's `body` as is. A file schema composes with either `t`.
const upload = formT.form({
  title: formT.string(),
  count: t.integer(),
  avatar: formT.file({ accept: ["image/png"] }),
  photos: t.array(formT.file()),
  cover: formT.optional(formT.file()),
})
type Upload = { title: string; count: number; avatar: File; photos: File[]; cover?: File }

export type _File = Expect<Equal<InferOutput<ReturnType<typeof formT.file>>, File>>
export type _Form = Expect<Equal<InferOutput<typeof upload>, Upload>>
const uploads = server().post("/uploads", { body: upload }, (c) => c.body.avatar)
export type _UploadApp = typeof uploads
export type _FormFlow = Expect<Equal<Context<"/uploads", { body: typeof upload }>["body"], Upload>>
// The plain `t` carries neither constructor: an app with no uploads ships none of that code.
// @ts-expect-error - `file` lives on the `t` of `@nifrajs/schema/form`
export const _noFile = t.file
// @ts-expect-error - `form` lives on the `t` of `@nifrajs/schema/form`
export const _noForm = t.form

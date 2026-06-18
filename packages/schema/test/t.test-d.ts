/**
 * Type-level contract for `t`: each constructor's inferred output type, and — the
 * payoff — that a `t` schema flows into `c.body` through `@nifrajs/core`'s existing
 * validation path with no special-casing. Verified by `tsc --noEmit`.
 */

import type { Context, InferOutput } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"
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

// The payoff: a `t` schema as a route body types `c.body` end-to-end — asserted on
// `Context` (exactly what the handler receives), and proven to compile through
// `server().post`.
export type _BodyFlow = Expect<
  Equal<Context<"/users", { body: typeof user }>["body"], { name: string; age: number }>
>
const app = server().post("/users", { body: user }, (c) => c.body)
export type _App = typeof app

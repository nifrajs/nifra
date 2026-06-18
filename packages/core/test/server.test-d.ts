/**
 * Type-level contract for path-param inference. Verified by `tsc`, not run.
 * This is the heart of the "inline magic": `c.params` typed from the path string
 * with no codegen.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { Params } from "../src/server/context.ts"

// No params -> no keys.
export type _NoParams = Expect<Equal<keyof Params<"/health">, never>>

// A single param.
export type _OneParam = Expect<Equal<Params<"/users/:id">, { id: string }>>

// Multiple params, in declaration order.
export type _TwoParams = Expect<Equal<Params<"/u/:id/p/:pid">, { id: string; pid: string }>>

// A non-literal path widens to an open record rather than collapsing to {}.
export type _WidePath = Expect<Equal<Params<string>, Record<string, string>>>

// Params are precise: a name that isn't in the path is a type error.
// @ts-expect-error - 'missing' is not a parameter of this route
export type _Precise = Params<"/users/:id">["missing"]

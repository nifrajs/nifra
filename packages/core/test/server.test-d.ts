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

// A name ends where the router ends it: at the first character that cannot be part of one.
export type _SuffixParam = Expect<Equal<Params<"/files/:name.json">, { name: string }>>
export type _TwoInOneSegment = Expect<
  Equal<Params<"/v:major.:minor">, { major: string; minor: string }>
>
export type _ThreeInOneSegment = Expect<
  Equal<Params<"/:a-:b-:c.json/x/:d">, { a: string; b: string; c: string; d: string }>
>
export type _PrefixedParam = Expect<Equal<Params<"/post-:id/edit">, { id: string }>>
export type _DigitsInName = Expect<Equal<Params<"/:v2_id@latest">, { v2_id: string }>>

// A colon that is literal text names nothing.
export type _RpcColon = Expect<Equal<keyof Params<"/v1/things:batchGet">, never>>
export type _RpcColonThenParam = Expect<Equal<Params<"/v1/things:batchGet/:id">, { id: string }>>
export type _BareColon = Expect<Equal<Params<"/a:/:id">, { id: string }>>
export type _ColonBeforeDigit = Expect<Equal<Params<"/at:30/:id">, { id: string }>>

// A wildcard, alone and after parameters.
export type _Wildcard = Expect<Equal<Params<"/files/*path">, { path: string }>>
export type _BareWildcard = Expect<Equal<Params<"/files/*">, { "*": string }>>
export type _ParamThenWildcard = Expect<
  Equal<Params<"/b/:bucket.s3/*key">, { bucket: string; key: string }>
>

// A non-literal path widens to an open record rather than collapsing to {}.
export type _WidePath = Expect<Equal<Params<string>, Record<string, string>>>

// Params are precise: a name that isn't in the path is a type error.
// @ts-expect-error - 'missing' is not a parameter of this route
export type _Precise = Params<"/users/:id">["missing"]

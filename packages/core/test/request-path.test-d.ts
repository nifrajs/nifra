import type { RequestPath } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"

/** `RequestPath` reads a route path the way the router does. Verified by `tsc`. */
export type _Static = Expect<Equal<RequestPath<"/health">, "/health">>
export type _Root = Expect<Equal<RequestPath<"/">, "/">>
export type _Param = Expect<Equal<RequestPath<"/users/:id">, `/users/${string}`>>
export type _TwoSegments = Expect<
  Equal<RequestPath<"/users/:id/posts/:postId">, `/users/${string}/posts/${string}`>
>
export type _Suffix = Expect<Equal<RequestPath<"/files/:name.json">, `/files/${string}.json`>>
export type _Prefix = Expect<Equal<RequestPath<"/post-:id">, `/post-${string}`>>
export type _TwoInOne = Expect<Equal<RequestPath<"/v:major.:minor">, `/v${string}.${string}`>>
export type _Wildcard = Expect<Equal<RequestPath<"/files/*path">, `/files/${string}`>>
export type _BareWildcard = Expect<Equal<RequestPath<"/files/*">, `/files/${string}`>>
export type _Constraint = Expect<Equal<RequestPath<"/users/:id{[0-9]+}">, `/users/${string}`>>
export type _CountedConstraint = Expect<
  Equal<RequestPath<"/codes/:code{[A-Z]{2}}/x">, `/codes/${string}/x`>
>
export type _ListConstraint = Expect<
  Equal<RequestPath<"/img/:kind{thumb|full}.png">, `/img/${string}.png`>
>
export type _LiteralColon = Expect<Equal<RequestPath<"/things:batchGet">, "/things:batchGet">>
export type _LiteralColonThenParam = Expect<
  Equal<RequestPath<"/things:batchGet/:id">, `/things:batchGet/${string}`>
>
export type _Optional = Expect<Equal<RequestPath<"/users/:id?">, "/users" | `/users/${string}`>>
export type _OptionalRun = Expect<
  Equal<RequestPath<"/:lang?/:page?">, "/" | `/${string}` | `/${string}/${string}`>
>
export type _NotAConstraint = Expect<Equal<RequestPath<"/a/:id{x}">, `/a/${string}{x}`>>
export type _Widened = Expect<Equal<RequestPath<string>, string>>

/**
 * Type-level contract for the router's public result type. Verified by `tsc`,
 * not run. Exported so `noUnusedLocals` treats each assertion as used.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { RouterMatch } from "../src/router/router.ts"

type Found<T> = Extract<RouterMatch<T>, { found: true }>
type MethodNotAllowed<T> = Extract<RouterMatch<T>, { reason: "method-not-allowed" }>

// The matched payload is exactly the router's type parameter.
export type _PayloadIsT = Expect<Equal<Found<{ id: number }>["payload"], { id: number }>>

// Params are always a string→string record (raw, undecoded values).
export type _ParamsShape = Expect<Equal<Found<number>["params"], Record<string, string>>>

// The 405 branch carries the allowed-method list.
export type _AllowedShape = Expect<Equal<MethodNotAllowed<number>["allowed"], string[]>>

import type { Jsonify } from "@nifrajs/client"
import type { Equal, Expect } from "@nifrajs/test-utils"

export type _Primitives = Expect<
  Equal<
    Jsonify<{ a: string; b: number; c: boolean; d: null }>,
    { a: string; b: number; c: boolean; d: null }
  >
>

export type _DateToString = Expect<Equal<Jsonify<{ at: Date }>, { at: string }>>

export type _Nested = Expect<
  Equal<
    Jsonify<{ user: { name: string; tags: string[] } }>,
    { user: { name: string; tags: string[] } }
  >
>

export type _DropsFunctions = Expect<Equal<Jsonify<{ a: string; fn: () => void }>, { a: string }>>

export type _ArrayOfObjects = Expect<Equal<Jsonify<Array<{ at: Date }>>, Array<{ at: string }>>>

export type _PreservesOptional = Expect<Equal<Jsonify<{ a?: string }>, { a?: string }>>

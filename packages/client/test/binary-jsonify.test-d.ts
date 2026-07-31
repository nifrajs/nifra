import type { BinaryResponse } from "@nifrajs/core/binary"
import type { Jsonify } from "../src/jsonify.ts"

/**
 * Type-level guard for the binary branch.
 *
 * `Jsonify` is load-bearing for the whole typed client - every route's `data` flows through it - so a
 * new arm at the top is exactly the change that can quietly reshape unrelated routes. These assert
 * both halves: the new type is `Blob`, and the shapes that were already right are untouched.
 */

type Expect<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// The point of the feature.
export type _binary = Expect<Equal<Jsonify<BinaryResponse>, Blob>>

/**
 * A plain `Response` must NOT become `Blob`. The brand is a phantom symbol precisely so an ordinary
 * `Response` cannot satisfy it - had the marker been an optional property, every type lacking it would
 * have matched and every raw-Response route would silently have started claiming to return bytes.
 */
export type _plainResponseIsNotBlob = Expect<
  Equal<Jsonify<Response> extends Blob ? true : false, false>
>

// Nothing below this line changed, and that is the assertion.
export type _string = Expect<Equal<Jsonify<string>, string>>
export type _date = Expect<Equal<Jsonify<Date>, string>>
export type _object = Expect<Equal<Jsonify<{ a: number; b: Date }>, { a: number; b: string }>>
export type _array = Expect<Equal<Jsonify<readonly number[]>, number[]>>
export type _optional = Expect<Equal<Jsonify<{ a?: string }>, { a?: string }>>
export type _unknown = Expect<Equal<Jsonify<unknown>, unknown>>
export type _nested = Expect<
  Equal<Jsonify<{ list: Array<{ at: Date }> }>, { list: Array<{ at: string }> }>
>

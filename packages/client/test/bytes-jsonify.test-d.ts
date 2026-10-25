import type { Treaty } from "@nifrajs/client"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import type { Base64Bytes } from "@nifrajs/core/binary"
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { Jsonify } from "../src/jsonify.ts"

/**
 * `bigint` and bytes in a JSON body. A `bigint` is written as its decimal string, a `t.bytes()` field as
 * base64, and any other typed array as the index object `JSON.stringify` makes of it. The brand on
 * `Base64Bytes` is optional, so these also pin that a plain `Uint8Array` does not read as a string.
 */

export type _bigint = Expect<Equal<Jsonify<bigint>, string>>
export type _bigintFields = Expect<
  Equal<
    Jsonify<{ id: bigint; ids: bigint[]; next?: bigint }>,
    { id: string; ids: string[]; next?: string }
  >
>
export type _declaredBytes = Expect<Equal<Jsonify<{ data: Base64Bytes }>, { data: string }>>
export type _plainBytes = Expect<Equal<Jsonify<Uint8Array>, { [index: number]: number }>>
export type _otherTypedArray = Expect<Equal<Jsonify<Float64Array>, { [index: number]: number }>>
export type _buffer = Expect<Equal<Jsonify<Buffer>, { type: "Buffer"; data: number[] }>>
export type _bigintArrays = Expect<
  Equal<
    Jsonify<{ signed: BigInt64Array; unsigned: BigUint64Array }>,
    { signed: { [index: number]: string }; unsigned: { [index: number]: string } }
  >
>

// A handler hands a declared field a plain `Uint8Array`.
export const _accepts: Base64Bytes = new Uint8Array(4)

declare const file: StandardSchemaV1<
  { name: string; data: Base64Bytes },
  { name: string; data: Base64Bytes }
>
const app = server()
  .get("/file", { response: file }, () => ({ name: "a.bin", data: new Uint8Array(4) }))
  .get("/raw", () => ({ data: new Uint8Array(4), id: 1n }))
declare const api: Treaty<typeof app>
type DataOf<P> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never

export type _fileData = Expect<
  Equal<DataOf<ReturnType<typeof api.file.get>>, { name: string; data: string }>
>
export type _rawData = Expect<
  Equal<DataOf<ReturnType<typeof api.raw.get>>, { data: { [index: number]: number }; id: string }>
>

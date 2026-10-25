import type { Base64BytesBrand, BinaryResponse, RawResponse } from "@nifrajs/core/binary"

/**
 * Maps a value to the shape it takes after a JSON round-trip, so the client's
 * `data` type reflects the wire - not the handler's in-memory return.
 *
 * - `Date` → `string`; `bigint` → its decimal `string`; `undefined` / functions → dropped from
 *   objects (a top-level `undefined` remains `undefined`, which is useful for bodyless statuses such as
 *   `204`)
 * - a `t.bytes()` field → its base64 `string`; any other typed array → the `{ "0": n, ... }` object
 *   `JSON.stringify` writes for it, a `BigInt64Array`'s entries as decimal strings (a `Buffer` → what
 *   its `toJSON` writes)
 * - arrays and plain objects recurse; optionality (`?`) is preserved
 *
 * Pragmatic by design: `Map`/`Set`/class instances/custom `toJSON` are treated as
 * plain objects (best-effort), not specially handled. Documented, not magic.
 */
type NumberArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array

type BigIntArray = BigInt64Array | BigUint64Array

type JsonifyNumberArray<T> = Base64BytesBrand extends keyof T
  ? string
  : T extends { toJSON(): infer J }
    ? Jsonify<J>
    : { [index: number]: number }

type JsonifyObjectProperty<T> = T extends undefined
  ? never
  : T extends (...args: never[]) => unknown
    ? never
    : Jsonify<T>

export type Jsonify<T> = [unknown] extends [T]
  ? unknown // `unknown`/`any` (e.g. a route with no response schema) stays opaque
  : // A route that declared itself binary with `bytes()`. Checked FIRST, before the object arm below
    // would try to describe a `Response`'s own properties and hand the caller a shape that says
    // nothing about the payload. The brand is a phantom symbol, so nothing else can match it.
    T extends BinaryResponse
    ? Blob
    : // A route that branded a hand-built `Response` with `raw<T>()`. Its payload rides `Jsonify` like any
      // other body; the brand is a required phantom symbol, so an ordinary `Response` cannot match here.
      T extends RawResponse<infer U>
      ? Jsonify<U>
      : T extends string | number | boolean | null
        ? T
        : T extends Date
          ? string
          : T extends bigint
            ? string
            : T extends (...args: never[]) => unknown
              ? never
              : T extends undefined
                ? undefined
                : T extends BigIntArray
                  ? { [index: number]: string }
                  : T extends NumberArray
                    ? JsonifyNumberArray<T>
                    : T extends ReadonlyArray<infer U>
                      ? Array<Jsonify<U>>
                      : T extends object
                        ? {
                            [K in keyof T as [JsonifyObjectProperty<T[K]>] extends [never]
                              ? never
                              : K]: JsonifyObjectProperty<T[K]>
                          }
                        : never

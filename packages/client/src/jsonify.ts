/**
 * Maps a value to the shape it takes after a JSON round-trip, so the client's
 * `data` type reflects the wire — not the handler's in-memory return.
 *
 * - `Date` → `string`; `undefined` / functions / `bigint` → dropped from objects
 * - arrays and plain objects recurse; optionality (`?`) is preserved
 *
 * Pragmatic by design: `Map`/`Set`/class instances/custom `toJSON` are treated as
 * plain objects (best-effort), not specially handled. Documented, not magic.
 */
export type Jsonify<T> = [unknown] extends [T]
  ? unknown // `unknown`/`any` (e.g. a route with no response schema) stays opaque
  : T extends string | number | boolean | null
    ? T
    : T extends Date
      ? string
      : T extends bigint
        ? never
        : T extends (...args: never[]) => unknown
          ? never
          : T extends undefined
            ? never
            : T extends ReadonlyArray<infer U>
              ? Array<Jsonify<U>>
              : T extends object
                ? { [K in keyof T as [Jsonify<T[K]>] extends [never] ? never : K]: Jsonify<T[K]> }
                : never

import {
  type ArrayOptions,
  type IntegerOptions,
  type NumberOptions,
  type ObjectOptions,
  type StringOptions,
  type TLiteralValue,
  type TSchema,
  type TUnion,
  Type,
} from "@sinclair/typebox"
import { fromTypeBox, type NifraSchema } from "./adapter.ts"

type Props = Record<string, NifraSchema>

/** Pull each property's raw TypeBox schema out of its `NifraSchema` wrapper. */
function unwrap<P extends Props>(props: P): { [K in keyof P]: P[K]["jsonSchema"] } {
  const out: Record<string, TSchema> = {}
  // Object.entries → own enumerable string keys only (no prototype walk).
  for (const [key, schema] of Object.entries(props)) out[key] = schema.jsonSchema
  return out as { [K in keyof P]: P[K]["jsonSchema"] }
}

/**
 * The built-in schema builder. Each constructor returns a `NifraSchema` — a
 * Standard Schema whose validated output type flows into `c.body`/`c.query`, and
 * whose `jsonSchema` powers `toOpenAPI`. Options (min/max, length, pattern, …)
 * pass straight through to TypeBox and so become JSON Schema constraints.
 *
 * Composite constructors are generic over the *inner* TypeBox schema `T extends
 * TSchema` (not over `NifraSchema`): reading `.jsonSchema` off a value typed only as
 * `NifraSchema` would erase to the `TSchema` constraint and collapse the output type
 * to `unknown`. Capturing `T` keeps `Static<T>` precise (`string[]`, not
 * `unknown[]`).
 */
export const t = {
  string: (options?: StringOptions) => fromTypeBox(Type.String(options)),
  number: (options?: NumberOptions) => fromTypeBox(Type.Number(options)),
  integer: (options?: IntegerOptions) => fromTypeBox(Type.Integer(options)),
  boolean: () => fromTypeBox(Type.Boolean()),
  null: () => fromTypeBox(Type.Null()),
  literal: <const L extends TLiteralValue>(value: L) => fromTypeBox(Type.Literal(value)),

  // `t.object` REJECTS unknown fields by default (`additionalProperties: false`) — the trust-boundary
  // rule. A body with extra keys fails validation (a 422), so `c.body` never carries attacker-supplied
  // properties (no mass-assignment). Use `t.looseObject` (or pass `{ additionalProperties: true }`) to
  // opt into an open object; an explicit `options.additionalProperties` always wins over the default.
  object: <P extends Props>(props: P, options?: ObjectOptions) =>
    fromTypeBox(Type.Object(unwrap(props), { additionalProperties: false, ...options })),
  /** Like `t.object` but ACCEPTS (and passes through) unknown fields — the explicit opt-out of the
   * strict default. Prefer `t.object` unless you genuinely need an open object. */
  looseObject: <P extends Props>(props: P, options?: ObjectOptions) =>
    fromTypeBox(Type.Object(unwrap(props), { additionalProperties: true, ...options })),
  array: <T extends TSchema>(item: NifraSchema<T>, options?: ArrayOptions) =>
    fromTypeBox(Type.Array(item.jsonSchema, options)),
  /** Marks a property optional inside `t.object`; standalone it is `T | undefined`. */
  optional: <T extends TSchema>(schema: NifraSchema<T>) =>
    fromTypeBox(Type.Optional(schema.jsonSchema)),
  // `const S` captures the argument as a tuple; the explicit return type then maps
  // over that captured tuple (`S[K]["jsonSchema"]`) so the union's `Static` is
  // `A | B`, not `unknown` — the value-level `.map` can't preserve per-element
  // types, so the output type is derived from `S` and the result cast to match
  // (order/length are preserved by `map`, so the tuple shape is sound).
  union: <const S extends readonly NifraSchema[]>(schemas: S) =>
    fromTypeBox(
      Type.Union((schemas as readonly NifraSchema[]).map((schema) => schema.jsonSchema)),
    ) as NifraSchema<TUnion<{ -readonly [K in keyof S]: S[K]["jsonSchema"] }>>,
  record: <T extends TSchema>(value: NifraSchema<T>, options?: ObjectOptions) =>
    fromTypeBox(Type.Record(Type.String(), value.jsonSchema, options)),

  // Composed from TypeBox directly (not `t.object`/`t.array`) so the `t` literal doesn't reference
  // itself during inference. Cursor pagination — not OFFSET — is the production default: stable under
  // concurrent inserts and O(1) per page. Build pages with `paginate()` + `encodeCursor`/`decodeCursor`.
  /** A cursor-pagination response envelope: `{ items: T[]; nextCursor: string | null }` (`null` = last page). */
  paginated: <T extends TSchema>(item: NifraSchema<T>, options?: ObjectOptions) =>
    fromTypeBox(
      Type.Object(
        {
          items: Type.Array(item.jsonSchema),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false, ...options },
      ),
    ),
  /** A request query schema for cursor pagination: `{ cursor?: string; limit?: number }`. `maxLimit`
   * caps `limit` — a larger value fails validation (a 422), so a client can't request an unbounded page.
   * `coerce` is on because query values arrive as strings (`?limit=20` → `"20"`); it's what makes `limit`
   * a real `number` in the handler (`c.query.limit`), not a string. */
  pageQuery: (options?: { maxLimit?: number }) =>
    fromTypeBox(
      Type.Object(
        {
          cursor: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: options?.maxLimit ?? 100 })),
        },
        { additionalProperties: false },
      ),
      { coerce: true },
    ),
  /** A request-query schema with string->scalar COERCION on. Query values always arrive as strings
   * (`?limit=20` -> `"20"`), so a plain `t.object({ limit: t.integer() })` in a `query` slot fails to
   * validate; use `t.query` and `t.integer()`/`t.number()`/`t.boolean()` fields become real numbers/
   * booleans in `c.query`. **Open by default** (unknown query fields pass through — `additionalProperties:
   * true`): query params are read by name, not spread into a DB write, so unknown params (UTM tracking,
   * `fbclid`, etc.) passing through is safe, and rejecting them is a production-only footgun (ad/social
   * traffic appends params your schema never declares, causing 422s that never appear in dev/CI). Pass
   * `{ additionalProperties: false }` to enforce a strict allowlist. This is the query-slot constructor;
   * `t.object` stays the constructor for body slots (no coercion, a JSON body is already typed). */
  query: <P extends Props>(props: P, options?: ObjectOptions) =>
    fromTypeBox(Type.Object(unwrap(props), { additionalProperties: true, ...options }), {
      coerce: true,
    }),
} as const

import {
  type ArrayOptions,
  CloneType,
  type IntegerOptions,
  Kind,
  type NumberOptions,
  type ObjectOptions,
  type Static,
  type StringOptions,
  type TArray,
  type TLiteralValue,
  type TSchema,
  type TUnion,
  type TUnsafe,
  Type,
  TypeRegistry,
} from "@sinclair/typebox"
import { fromTypeBox, type NifraSchema } from "./adapter.ts"
import { fileOps, refuseFile } from "./file-kind.ts"

type Props = Record<string, NifraSchema>

/** A value `defer()` from `@nifrajs/web` marked to stream in after the page shell. */
export interface DeferredValue<T> {
  readonly __nifra_deferred: true
  readonly id: number
  readonly promise: Promise<T>
}

const DEFERRED_KIND = "NifraDeferred"
/** Where `@nifrajs/web`'s output guard finds the inner schema's validate. Registered for two copies. */
const DEFERRED_VALIDATE = Symbol.for("nifra.schema.deferredValidate")

const isDeferredValue = (_: unknown, value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly __nifra_deferred?: unknown }).__nifra_deferred === true &&
  typeof (value as { readonly promise?: { readonly then?: unknown } }).promise?.then === "function"

/**
 * Pull each property's raw TypeBox schema out of its `NifraSchema` wrapper. `where` names the calling
 * constructor: these objects are checked as JSON, so a file field is refused here (it belongs in
 * `t.form` from `@nifrajs/schema/form`) instead of failing every request later.
 */
function unwrap<P extends Props>(where: string, props: P): { [K in keyof P]: P[K]["jsonSchema"] } {
  const out: Record<string, TSchema> = {}
  // Object.entries → own enumerable string keys only (no prototype walk).
  for (const [key, schema] of Object.entries(props)) {
    refuseFile(where, schema.jsonSchema)
    out[key] = schema.jsonSchema
  }
  return out as { [K in keyof P]: P[K]["jsonSchema"] }
}

/** An open object whose scalar fields are coerced from strings - the shape of every request input
 * that arrives as name/value text (a query string, a `Cookie` header). */
const textFields =
  (where: string) =>
  <P extends Props>(props: P, options?: ObjectOptions) =>
    fromTypeBox(Type.Object(unwrap(where, props), { additionalProperties: true, ...options }), {
      coerce: true,
    })

/**
 * The built-in schema builder. Each constructor returns a `NifraSchema` - a
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

  // `t.object` REJECTS unknown fields by default (`additionalProperties: false`) - the trust-boundary
  // rule. A body with extra keys fails validation (a 422), so `c.body` never carries attacker-supplied
  // properties (no mass-assignment). Use `t.looseObject` (or pass `{ additionalProperties: true }`) to
  // opt into an open object; an explicit `options.additionalProperties` always wins over the default.
  object: <P extends Props>(props: P, options?: ObjectOptions) =>
    fromTypeBox(
      Type.Object(unwrap("t.object", props), { additionalProperties: false, ...options }),
    ),
  /** Like `t.object` but ACCEPTS (and passes through) unknown fields - the explicit opt-out of the
   * strict default. Prefer `t.object` unless you genuinely need an open object. */
  looseObject: <P extends Props>(props: P, options?: ObjectOptions) =>
    fromTypeBox(
      Type.Object(unwrap("t.looseObject", props), { additionalProperties: true, ...options }),
    ),
  /**
   * A list. A list of `t.file()` (from `@nifrajs/schema/form`) honors `minItems` / `maxItems` and is
   * used inside `t.form`.
   */
  array: <T extends TSchema>(
    item: NifraSchema<T>,
    options?: ArrayOptions,
  ): NifraSchema<TArray<T>> =>
    (fileOps("t.array", item)?.array(item, options) as NifraSchema<TArray<T>> | undefined) ??
    fromTypeBox(Type.Array(item.jsonSchema, options)),
  /** Marks a property optional inside `t.object` / `t.form`; standalone it is `T | undefined`. */
  optional: <T extends TSchema>(schema: NifraSchema<T>) => {
    const plain = () => fromTypeBox(Type.Optional(schema.jsonSchema))
    return (
      (fileOps("t.optional", schema)?.optional(schema) as ReturnType<typeof plain> | undefined) ??
      plain()
    )
  },
  // `const S` captures the argument as a tuple; the explicit return type then maps
  // over that captured tuple (`S[K]["jsonSchema"]`) so the union's `Static` is
  // `A | B`, not `unknown` - the value-level `.map` can't preserve per-element
  // types, so the output type is derived from `S` and the result cast to match
  // (order/length are preserved by `map`, so the tuple shape is sound).
  union: <const S extends readonly NifraSchema[]>(schemas: S) =>
    fromTypeBox(
      Type.Union(
        (schemas as readonly NifraSchema[]).map((schema) => {
          refuseFile("t.union", schema.jsonSchema)
          return schema.jsonSchema
        }),
      ),
    ) as NifraSchema<TUnion<{ -readonly [K in keyof S]: S[K]["jsonSchema"] }>>,
  record: <T extends TSchema>(value: NifraSchema<T>, options?: ObjectOptions) => {
    refuseFile("t.record", value.jsonSchema)
    return fromTypeBox(Type.Record(Type.String(), value.jsonSchema, options))
  },

  // Composed from TypeBox directly (not `t.object`/`t.array`) so the `t` literal doesn't reference
  // itself during inference. Cursor pagination - not OFFSET - is the production default: stable under
  // concurrent inserts and O(1) per page. Build pages with `paginate()` + `encodeCursor`/`decodeCursor`.
  /** A cursor-pagination response envelope: `{ items: T[]; nextCursor: string | null }` (`null` = last page). */
  paginated: <T extends TSchema>(item: NifraSchema<T>, options?: ObjectOptions) => {
    refuseFile("t.paginated", item.jsonSchema)
    return fromTypeBox(
      Type.Object(
        {
          items: Type.Array(item.jsonSchema),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false, ...options },
      ),
    )
  },
  /** A request query schema for cursor pagination: `{ cursor?: string; limit?: number }`. `maxLimit`
   * caps `limit` - a larger value fails validation (a 422), so a client can't request an unbounded page.
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
   * booleans in `c.query`. **Open by default** (unknown query fields pass through - `additionalProperties:
   * true`): query params are read by name, not spread into a DB write, so unknown params (UTM tracking,
   * `fbclid`, etc.) passing through is safe, and rejecting them is a production-only footgun (ad/social
   * traffic appends params your schema never declares, causing 422s that never appear in dev/CI). Pass
   * `{ additionalProperties: false }` to enforce a strict allowlist. This is the query-slot constructor;
   * `t.object` stays the constructor for body slots (no coercion, a JSON body is already typed). */
  query: textFields("t.query"),
  /** A request-cookie schema for the `cookies` route slot, with the same string->scalar COERCION as
   * `t.query` (cookie values always arrive as strings). **Open by default**: a browser sends every
   * cookie the site has set - analytics, consent, other routes' sessions - so a strict allowlist
   * would 422 real traffic. Declare the cookies the route reads; the rest pass through. */
  cookies: textFields("t.cookies"),

  /**
   * A loader value marked with `defer()`, streamed in after the shell. `inner` describes what the
   * promise resolves to; `@nifrajs/web` projects and validates the resolved value by it before it
   * streams, so a deferred value is held to the same output contract as the rest of the data.
   */
  deferred: <T extends TSchema>(
    inner: NifraSchema<T>,
  ): NifraSchema<TUnsafe<DeferredValue<Static<T>>>> => {
    refuseFile("t.deferred", inner.jsonSchema)
    if (!TypeRegistry.Has(DEFERRED_KIND)) TypeRegistry.Set(DEFERRED_KIND, isDeferredValue)
    return fromTypeBox(
      Type.Unsafe<DeferredValue<Static<T>>>({
        [Kind]: DEFERRED_KIND,
        "x-nifra-deferred": true,
        inner: inner.jsonSchema,
        [DEFERRED_VALIDATE]: inner["~standard"].validate,
      }),
    )
  },
  /**
   * Allow a field with a sensitive name (`token`, `password`, `apiKey`, ...) in an output schema.
   * An output schema that declares one without this fails at route load; `reason` records why this
   * value may reach the browser, for the reviewer who finds it later.
   */
  declassified: <T extends TSchema>(reason: string, schema: NifraSchema<T>): NifraSchema<T> => {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new TypeError("t.declassified: give the reason this field may reach the browser")
    }
    refuseFile("t.declassified", schema.jsonSchema)
    return fromTypeBox(CloneType(schema.jsonSchema, { "x-nifra-declassified": reason }) as T)
  },
} as const

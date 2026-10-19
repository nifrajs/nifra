import type {
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
  StandardTypes,
} from "@nifrajs/core/schema"
import { Kind, type Static, type TSchema } from "@sinclair/typebox"
import { type TypeCheck, TypeCompiler } from "@sinclair/typebox/compiler"
import { Value } from "@sinclair/typebox/value"
import { ensureDefaultFormats } from "./formats.ts"

/**
 * A `t` schema. It is a Standard Schema (so any nifra route validates it with no
 * special-casing) whose raw TypeBox definition stays reachable as `jsonSchema` -
 * and because a TypeBox schema *is* a JSON Schema, that field is exactly what lets
 * `toOpenAPI` emit a real request/response schema for the route. BYO Standard
 * Schemas (zod/valibot/arktype) validate too but expose no JSON Schema, so only
 * `t`-based routes get full OpenAPI.
 */
export type NifraSchema<T extends TSchema = TSchema> = StandardSchemaV1<Static<T>, Static<T>> & {
  readonly jsonSchema: T
}

/**
 * Map a TypeBox validation error to a Standard Schema issue. TypeBox reports JSON
 * Pointers (`"/name"`, `"/items/0"`); Standard Schema wants a segment array (`""` is
 * the document root → no path). The compiled checker and the eval-free `Value`
 * checker emit the same error shape, so both validation paths share this.
 */
function toIssue(error: { readonly message: string; readonly path: string }): StandardIssue {
  return {
    message: error.message,
    path: error.path === "" ? undefined : error.path.slice(1).split("/"),
  }
}

// The issues past this are never reported (a 422 lists 100), so walking them is wasted work on a
// large hostile body.
const MAX_ISSUES = 100

/** Marks a coercing `validate`. On the function, not the schema, so a spread copy keeps it. */
export const COERCES = Symbol.for("nifra.schema.coerce")

// Every `validate` that checks its `jsonSchema` and nothing else: the only kind precompilation can
// replace. A wrapper (`t.form`'s coercion and multipart reader, a hand-written Standard Schema) is
// absent, so it is refused rather than compiled into a validator that drops what it adds.
const PLAIN_VALIDATORS = new WeakSet<object>()

/** Whether `schema` validates by its `jsonSchema` alone, as `fromTypeBox` without `coerce` builds it. */
export function validatesByJsonSchemaAlone(schema: {
  readonly "~standard": { readonly validate: object }
}): boolean {
  return PLAIN_VALIDATORS.has(schema["~standard"].validate)
}

function firstIssues(
  errors: Iterable<{ readonly message: string; readonly path: string }>,
): StandardIssue[] {
  const issues: StandardIssue[] = []
  for (const error of errors) {
    issues.push(toIssue(error))
    if (issues.length === MAX_ISSUES) break
  }
  return issues
}

// ---------------------------------------------------------------------------------------------
// Precompiled coercion for flat scalar objects - the shape every real query schema has.
//
// `Value.Convert` walks the schema tree interpretively on EVERY validate call (measured ~115ns for
// a 3-field query schema vs ~5ns for the compiled Check it feeds - 23x the cost of validation
// itself). A `coerce` schema whose properties are all plain String/Number/Integer/Boolean can have
// its conversion plan extracted ONCE at construction and replayed as a flat loop per request.
//
// Every converter below mirrors `@sinclair/typebox/value` `convert.mjs` byte-for-byte - including
// its quirks (global-`isNaN` string coercion, radix-less `parseInt` so `"0x10"` → 16, `"1"`/
// `"true"` truthiness, `-0` handling) - and the object walk mirrors `FromObject` (`key in value`
// including the prototype chain, in-place mutation, arrays/non-objects passed through untouched).
// A schema with ANY other property kind (unions, literals, arrays, nested objects, dates, refs)
// gets `plan = null` and keeps taking the full `Value.Convert` path, so semantics never fork. The
// parity is pinned by a property-based test that diffs this plan against `Value.Convert` itself.
// ---------------------------------------------------------------------------------------------

type ScalarKind = "String" | "Number" | "Integer" | "Boolean"
type CoercionPlan = ReadonlyArray<readonly [key: string, kind: ScalarKind]>

/** Extract a flat conversion plan, or `null` when this schema needs the full recursive Convert. */
function flatCoercionPlan(schema: TSchema): CoercionPlan | null {
  if ((schema as unknown as Record<symbol, unknown>)[Kind] !== "Object") return null
  const props = (schema as { readonly properties?: unknown }).properties
  if (props === null || typeof props !== "object") return null
  const record = props as Record<string, TSchema>
  const plan: Array<readonly [string, ScalarKind]> = []
  for (const key of Object.getOwnPropertyNames(record)) {
    const kind = (record[key] as unknown as Record<symbol, unknown> | undefined)?.[Kind]
    if (kind === "String" || kind === "Number" || kind === "Integer" || kind === "Boolean") {
      plan.push([key, kind])
    } else {
      return null
    }
  }
  return plan
}

// TypeBox's IsStringNumeric: global isNaN (string-coercing) + parseFloat guard, verbatim.
const isStringNumeric = (v: string): boolean =>
  // biome-ignore lint/suspicious/noGlobalIsNan: mirrors TypeBox's own coercing `isNaN` check exactly.
  !isNaN(v as unknown as number) && !isNaN(parseFloat(v))

const isValueTrue = (v: unknown): boolean =>
  v === true ||
  (typeof v === "number" && v === 1) ||
  (typeof v === "bigint" && v === BigInt(1)) ||
  (typeof v === "string" && (v.toLowerCase() === "true" || v === "1"))

const isValueFalse = (v: unknown): boolean =>
  v === false ||
  (typeof v === "number" && (v === 0 || Object.is(v, -0))) ||
  (typeof v === "bigint" && v === BigInt(0)) ||
  (typeof v === "string" && (v.toLowerCase() === "false" || v === "0" || v === "-0"))

function convertScalar(kind: ScalarKind, v: unknown): unknown {
  switch (kind) {
    case "Number":
      return typeof v === "string" && isStringNumeric(v)
        ? parseFloat(v)
        : isValueTrue(v)
          ? 1
          : isValueFalse(v)
            ? 0
            : v
    case "Integer":
      return typeof v === "string" && isStringNumeric(v)
        ? // Radix-less on purpose: TypeBox's Convert uses bare `parseInt(value)`, so `"0x10"`
          // converts to 16 - adding a radix would fork semantics from the path this mirrors.
          // biome-ignore lint/correctness/useParseIntRadix: parity with TypeBox Convert (see above)
          parseInt(v)
        : typeof v === "number"
          ? Math.trunc(v)
          : isValueTrue(v)
            ? 1
            : isValueFalse(v)
              ? 0
              : v
    case "Boolean":
      return isValueTrue(v) ? true : isValueFalse(v) ? false : v
    case "String":
      return typeof v === "symbol" && v.description !== undefined
        ? v.description.toString()
        : typeof v === "bigint" || typeof v === "boolean" || typeof v === "number"
          ? v.toString()
          : v
  }
}

/** What ends or rewrites a single-quoted string in generated source. */
const UNSAFE_IN_QUOTES = /['\\\n\r\u2028\u2029]/
/** A quote is safe in a literal (TypeBox escapes it there); a backslash or line break is not. */
const UNSAFE_IN_LITERAL = /[\\\n\r\u2028\u2029]/

/**
 * TypeBox's `TypeCompiler` splices schema text into generated source inside single quotes: a
 * `Type.Literal` string escaped for quotes only (`LiteralString.Escape`), and property keys (a closed
 * object's key list), a `format` name and a custom `Kind` not escaped at all. A backslash there is
 * reinterpreted as an escape sequence - the checker reads a DIFFERENT property or literal and
 * silently fails valid input - a line break breaks the source, and a quote ends the string so the
 * rest runs as code. The interpretive `Value` checker has no codegen step and handles all of them,
 * so a schema carrying the hazard is pinned to the eval-free path up front. Detected once at
 * construction over the raw JSON schema tree.
 */
export function hasCompileHazard(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false
  if (Array.isArray(node)) return node.some(hasCompileHazard)
  const record = node as Record<PropertyKey, unknown>
  const kind = record[Kind]
  if (typeof kind === "string" && UNSAFE_IN_QUOTES.test(kind)) return true
  // A tuple's length check splices `maxItems` in without TypeBox's usual number guard.
  if (kind === "Tuple" && record.maxItems !== undefined && typeof record.maxItems !== "number")
    return true
  for (const key of Object.getOwnPropertyNames(record)) {
    const value = record[key]
    if (
      (key === "properties" || key === "patternProperties") &&
      value !== null &&
      typeof value === "object" &&
      Object.getOwnPropertyNames(value).some((prop) => UNSAFE_IN_QUOTES.test(prop))
    ) {
      return true
    }
    if (key === "const" && typeof value === "string" && UNSAFE_IN_LITERAL.test(value)) return true
    if (key === "format" && typeof value === "string" && UNSAFE_IN_QUOTES.test(value)) return true
    if (hasCompileHazard(value)) return true
  }
  return false
}

/** Replay a flat plan over `value` - the fast equivalent of `Value.Convert` for eligible schemas. */
function convertFlat(plan: CoercionPlan, value: unknown): unknown {
  // Mirrors FromObject's guards: only a non-array object is converted (in place), anything else
  // passes through for the Check to reject.
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  for (const [key, kind] of plan) {
    if (!(key in record)) continue // `in` (not hasOwn) - TypeBox's HasPropertyKey is `key in value`
    record[key] = convertScalar(kind, record[key])
  }
  return value
}

/**
 * On a plain `fromTypeBox` validate, shared with `@nifrajs/web`'s output guard. Called with the
 * JSON Schema the caller projected a value by, it returns a validate for that projected value, or
 * `undefined` when that schema is not this validate's own or the variant would skip nothing.
 */
const VALIDATE_PROJECTED = Symbol.for("nifra.schema.validateProjected")

const isSchemaNode = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isTypeBoxSchema = (value: unknown): value is TSchema =>
  isSchemaNode(value) && typeof value[Kind] === "string"

/**
 * `node` without the undeclared-key check (`additionalProperties: false`) of each object a
 * projection by declared keys reaches directly: the root, then through properties, array items,
 * tuple slots, record values and an extra-key schema. A union, intersection, `not` or `$id` target
 * is not entered: a union's projection keeps the keys of every branch, so each branch still needs
 * its own check. Returns `node` itself when nothing below changes.
 */
function withoutKeyChecks(node: unknown): unknown {
  if (!isSchemaNode(node) || node.$id !== undefined) return node
  const kind = node[Kind]
  let out: Record<PropertyKey, unknown> | undefined
  const replace = (key: string, value: unknown): void => {
    out ??= { ...node }
    out[key] = value
  }
  if (kind === "Object" || kind === "Record") {
    for (const field of ["properties", "patternProperties"]) {
      const subs = node[field]
      if (!isSchemaNode(subs)) continue
      let next: Record<string, unknown> | undefined
      for (const key of Object.keys(subs)) {
        const sub = withoutKeyChecks(subs[key])
        if (sub === subs[key]) continue
        next ??= { ...subs }
        next[key] = sub
      }
      if (next !== undefined) replace(field, next)
    }
    const extra = node.additionalProperties
    if (kind === "Object" && extra === false && node.patternProperties === undefined) {
      const { additionalProperties: _closed, ...open } = out ?? node
      out = open
    } else if (isSchemaNode(extra)) {
      const sub = withoutKeyChecks(extra)
      if (sub !== extra) replace("additionalProperties", sub)
    }
  } else if (kind === "Array" && isSchemaNode(node.items)) {
    const sub = withoutKeyChecks(node.items)
    if (sub !== node.items) replace("items", sub)
  } else if (kind === "Tuple") {
    const slots = node.items
    if (Array.isArray(slots)) {
      const items = slots.map(withoutKeyChecks)
      if (items.some((sub, i) => sub !== slots[i])) replace("items", items)
    }
  }
  return out ?? node
}

/**
 * Wrap a TypeBox schema as a `NifraSchema`.
 *
 * **Validation is fast where it can be, and works everywhere.** The first `validate`
 * builds a compiled `TypeCompiler` validator (codegen via `new Function`) and memoizes
 * it - composing schemas (`t.object({ a: t.string() })`) never compiles the inner
 * pieces; only a schema actually used to validate a request pays the one-time codegen
 * cost. On Bun and Node this is the only path and it is untouched.
 *
 * Edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy) **forbid dynamic code
 * generation**, so that first compile throws there. We catch it once per schema and
 * fall back to TypeBox's eval-free `Value` checker - same semantics (and same global
 * `FormatRegistry`, so `t.string({ format })` behaves identically), no `new Function`.
 * A browser page starts on that checker, so a strict CSP or Trusted Types sees no
 * compile attempt. The branch is decided once and memoized, so the hot path is a single
 * check either way.
 *
 * Exposed (not just used internally by `t`) so a TypeBox schema authored directly can
 * be adapted without leaving the Standard Schema world.
 *
 * `options.coerce` runs TypeBox's `Value.Convert` (string→number/integer/boolean, per the schema)
 * BEFORE validating. Query values always arrive as strings (`?limit=20` → `"20"`), so a query schema
 * with a numeric field can't validate without this - it's how `t.pageQuery` yields a real `number`.
 * Leave it OFF (the default) for body/JSON schemas: a JSON number is already a number, and coercing
 * would silently accept `"20"` where the contract said `20`.
 */
export function fromTypeBox<T extends TSchema>(
  schema: T,
  options?: { readonly coerce?: boolean },
): NifraSchema<T> {
  const coerce = options?.coerce ?? false
  // Built once per schema: a flat scalar object replays a cheap per-key plan on each validate; any
  // other shape keeps the full recursive `Value.Convert` (plan stays null). See flatCoercionPlan.
  const coercionPlan = coerce ? flatCoercionPlan(schema) : null
  let compiled: TypeCheck<T> | undefined
  // A backslash-carrying key/literal would MISCOMPILE (not throw) under TypeCompiler - see
  // hasCompileHazard. Start such schemas on the eval-free path. So does a browser page: under a CSP
  // without 'unsafe-eval', or Trusted Types, the compile attempt is a violation the browser logs and
  // reports, once per schema, before the fallback below catches it.
  let evalFree = hasCompileHazard(schema) || "document" in globalThis
  const result: NifraSchema<T> = {
    "~standard": {
      version: 1,
      vendor: "nifra",
      validate: (value: unknown): StandardResult<Static<T>> => {
        // Install the standard string formats before the first Compile/Check. Driven from this
        // reachable path (not a top-level import side effect) so a production bundle can't
        // tree-shake the registration away - see ./formats.ts. Idempotent, ~free after first call.
        ensureDefaultFormats()
        // Coerce first when asked (query schemas): `Value.Convert` turns "20"→20 per the schema, so the
        // compiled/eval-free Check below sees the target type. A non-convertible value (e.g. "abc" for an
        // integer) is left as-is and fails Check → a proper 400.
        const input = coerce
          ? coercionPlan !== null
            ? convertFlat(coercionPlan, value)
            : Value.Convert(schema, value)
          : value
        if (compiled === undefined && !evalFree) {
          try {
            compiled = TypeCompiler.Compile(schema)
          } catch {
            // Dynamic codegen disallowed (edge): take the eval-free path for this schema.
            evalFree = true
          }
        }
        if (compiled !== undefined) {
          if (compiled.Check(input)) return { value: input as Static<T> }
          return { issues: firstIssues(compiled.Errors(input)) }
        }
        if (Value.Check(schema, input)) return { value: input as Static<T> }
        return { issues: firstIssues(Value.Errors(schema, input)) }
      },
      // Phantom: `types` carries no runtime value; this cast supplies the
      // compile-time `Static<T>` that nifra's `InferOutput` reads to type `c.body`.
      types: undefined as unknown as StandardTypes<Static<T>, Static<T>>,
    },
    jsonSchema: schema,
  }
  if (coerce) Object.defineProperty(result["~standard"].validate, COERCES, { value: true })
  else {
    PLAIN_VALIDATORS.add(result["~standard"].validate)
    // Built when the output guard first asks, at route load: most schemas never validate one.
    let projected: NifraSchema["~standard"]["validate"] | null | undefined
    Object.defineProperty(result["~standard"].validate, VALIDATE_PROJECTED, {
      value: (projectedBy: unknown) => {
        if (projectedBy !== schema) return undefined
        if (projected === undefined) {
          const open = withoutKeyChecks(schema)
          projected =
            open !== schema && isTypeBoxSchema(open)
              ? fromTypeBox(open)["~standard"].validate
              : null
        }
        return projected ?? undefined
      },
    })
  }
  return result
}

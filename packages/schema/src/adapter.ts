import type { StandardIssue, StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import type { Static, TSchema } from "@sinclair/typebox"
import { type TypeCheck, TypeCompiler } from "@sinclair/typebox/compiler"
import { Value } from "@sinclair/typebox/value"
import { ensureDefaultFormats } from "./formats.ts"

/**
 * A `t` schema. It is a Standard Schema (so any nifra route validates it with no
 * special-casing) whose raw TypeBox definition stays reachable as `jsonSchema` —
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

/**
 * Wrap a TypeBox schema as a `NifraSchema`.
 *
 * **Validation is fast where it can be, and works everywhere.** The first `validate`
 * builds a compiled `TypeCompiler` validator (codegen via `new Function`) and memoizes
 * it — composing schemas (`t.object({ a: t.string() })`) never compiles the inner
 * pieces; only a schema actually used to validate a request pays the one-time codegen
 * cost. On Bun and Node this is the only path and it is untouched.
 *
 * Edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy) **forbid dynamic code
 * generation**, so that first compile throws there. We catch it once per schema and
 * fall back to TypeBox's eval-free `Value` checker — same semantics (and same global
 * `FormatRegistry`, so `t.string({ format })` behaves identically), no `new Function`.
 * The branch is decided once and memoized, so the hot path is a single check either way.
 *
 * Exposed (not just used internally by `t`) so a TypeBox schema authored directly can
 * be adapted without leaving the Standard Schema world.
 *
 * `options.coerce` runs TypeBox's `Value.Convert` (string→number/integer/boolean, per the schema)
 * BEFORE validating. Query values always arrive as strings (`?limit=20` → `"20"`), so a query schema
 * with a numeric field can't validate without this — it's how `t.pageQuery` yields a real `number`.
 * Leave it OFF (the default) for body/JSON schemas: a JSON number is already a number, and coercing
 * would silently accept `"20"` where the contract said `20`.
 */
export function fromTypeBox<T extends TSchema>(schema: T, options?: { readonly coerce?: boolean }): NifraSchema<T> {
  const coerce = options?.coerce ?? false
  let compiled: TypeCheck<T> | undefined
  let evalFree = false
  return {
    "~standard": {
      version: 1,
      vendor: "nifra",
      validate: (value: unknown): StandardResult<Static<T>> => {
        // Install the standard string formats before the first Compile/Check. Driven from this
        // reachable path (not a top-level import side effect) so a production bundle can't
        // tree-shake the registration away — see ./formats.ts. Idempotent, ~free after first call.
        ensureDefaultFormats()
        // Coerce first when asked (query schemas): `Value.Convert` turns "20"→20 per the schema, so the
        // compiled/eval-free Check below sees the target type. A non-convertible value (e.g. "abc" for an
        // integer) is left as-is and fails Check → a proper 400.
        const input = coerce ? Value.Convert(schema, value) : value
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
          return { issues: [...compiled.Errors(input)].map(toIssue) }
        }
        if (Value.Check(schema, input)) return { value: input as Static<T> }
        return { issues: [...Value.Errors(schema, input)].map(toIssue) }
      },
      // Phantom: `types` carries no runtime value; this cast supplies the
      // compile-time `Static<T>` that nifra's `InferOutput` reads to type `c.body`.
      types: undefined as unknown as StandardTypes<Static<T>, Static<T>>,
    },
    jsonSchema: schema,
  }
}

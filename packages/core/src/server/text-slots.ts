import type { StandardSchemaV1 } from "../schema/standard.ts"
import type { RouteSchema } from "./context.ts"

// What a schema offers for a slot whose values arrive as text: `@nifrajs/schema` sets it on a
// `t.object` (and any `t` schema that does not coerce) to the coercing form of the same schema.
const TEXT_SLOT = Symbol.for("nifra.schema.textSlot")

/**
 * `schema` with its `query`, `headers` and `cookies` schemas swapped for the text form each offers, or
 * `schema` itself when none offers one. A query string, header values and a `Cookie` header are
 * always text, so a schema that reads a boolean or a number there can only validate its coercing form.
 */
export function withTextSlots(schema: RouteSchema | undefined): RouteSchema | undefined {
  let out = schema
  for (const slot of ["query", "headers", "cookies"] as const) {
    const validate = out?.[slot]?.["~standard"].validate
    const form: StandardSchemaV1 | undefined = validate && Reflect.get(validate, TEXT_SLOT)
    if (form !== undefined) out = { ...out, [slot]: form }
  }
  return out
}

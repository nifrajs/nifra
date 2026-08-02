/**
 * The DEFAULT `reflectJsonSchema` hook: recognize a zod schema by its Standard Schema vendor tag and
 * derive the inspectable JSON Schema the mock/mutation generators read - with no wiring at all.
 *
 * Standard Schema standardizes validation, not introspection, so an opaque validator normally leaves a
 * route unmockable (`{}`) and unwitnessed (`NO_WITNESS`) unless the caller passes a bridge. But every
 * Standard Schema carries `"~standard".vendor`, and zod ships its own converter (`z.toJSONSchema`,
 * zod 4+) - so when the vendor says "zod" and zod is resolvable from here, the bridge can be applied
 * automatically. Everything about it fails soft: no zod installed, an older zod without `toJSONSchema`,
 * a non-zod vendor, or a schema zod cannot convert (custom transforms) all return `undefined`, which is
 * exactly the opaque behavior a caller saw before this existed. An explicit `reflectJsonSchema` option
 * always wins over this default.
 *
 * zod stays an OPTIONAL peer: it is loaded lazily via `createRequire` (never a static import), probed
 * once per process, and its absence is a cached miss - a zod-free project pays one failed resolve, ever.
 * Conversion options mirror `@nifrajs/testing/zod` (`zodJsonSchema`), which remains the explicit form:
 *   - target "draft-7" → the keyword set the mock generator + `candidateMutations` read
 *   - io "input"       → the request-side constraints a hostile payload must violate (pre-transform)
 *   - reused "inline"  → no `$ref`/`$defs`; the mock generator fails closed on `$ref`
 */
import { createRequire } from "node:module"
import type { JsonSchema } from "@nifrajs/core/reflection"

const ZOD_TO_JSON_SCHEMA_OPTIONS = { target: "draft-7", io: "input", reused: "inline" } as const

type ToJSONSchema = (schema: unknown, options?: unknown) => unknown

// Tri-state probe cache: `undefined` = not probed yet, `null` = zod (or its converter) is unavailable.
let cachedToJSONSchema: ToJSONSchema | null | undefined
const zodToJSONSchema = (): ToJSONSchema | null => {
  if (cachedToJSONSchema !== undefined) return cachedToJSONSchema
  try {
    const zod = createRequire(import.meta.url)("zod") as { toJSONSchema?: unknown }
    cachedToJSONSchema =
      typeof zod.toJSONSchema === "function" ? (zod.toJSONSchema as ToJSONSchema) : null
  } catch {
    cachedToJSONSchema = null
  }
  return cachedToJSONSchema
}

/**
 * Derive a JSON Schema from a zod Standard Schema, or `undefined` for anything else (non-zod vendors,
 * zod not installed, unconvertible schemas). Safe as an always-on default: it can only ever turn an
 * opaque schema inspectable, never change one that already carries JSON Schema metadata.
 */
export function autoReflectJsonSchema(schema: unknown): JsonSchema | undefined {
  const vendor = (schema as { readonly "~standard"?: { readonly vendor?: unknown } } | undefined)?.[
    "~standard"
  ]?.vendor
  if (vendor !== "zod") return undefined
  const toJSONSchema = zodToJSONSchema()
  if (toJSONSchema === null) return undefined
  try {
    const json = toJSONSchema(schema, ZOD_TO_JSON_SCHEMA_OPTIONS)
    return json === null || json === undefined ? undefined : (json as JsonSchema)
  } catch {
    return undefined
  }
}

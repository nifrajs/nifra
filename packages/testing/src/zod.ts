/**
 * `@nifrajs/testing/zod` - bridge a zod schema to the inspectable JSON Schema the adversarial laboratory
 * and `@nifrajs/mock` generate from. zod implements Standard Schema (nifra already VALIDATES with it) but
 * carries no `.jsonSchema`, so without this the laboratory reports NO_WITNESS for every zod route and emits
 * only generic type-confusion mutations, and the mock server returns `{}` for zod responses. Wire it in:
 *
 *   import { zodJsonSchema } from "@nifrajs/testing/zod"
 *   await assertAdversarialContract(app, { reflectJsonSchema: zodJsonSchema })
 *   // and/or: createMockServer(app, { reflectJsonSchema: zodJsonSchema })
 *
 * zod is an OPTIONAL peer: this module is only reachable through the `./zod` subpath, so a non-zod project
 * never loads zod. Requires the `z.toJSONSchema` era (zod 4; verified against 4.4.3).
 */
import type { JsonSchema } from "@nifrajs/core/reflection"
import * as z from "zod"

// Accessed defensively so a zod build without `toJSONSchema` degrades to today's behavior rather than
// crashing at import. Present since zod 4.
const toJSONSchema = (z as { toJSONSchema?: (schema: unknown, options?: unknown) => unknown })
  .toJSONSchema

/**
 * Convert a zod schema to a JSON Schema the mock/mutation generators understand, or `undefined` when the
 * value is not a convertible zod schema. Options chosen for this consumer:
 *   - target "draft-7" → the keyword set `@nifrajs/mock` + the laboratory's `candidateMutations` read
 *   - io "input"       → the request-side constraints a hostile payload must violate (pre-transform)
 *   - reused "inline"  → no `$ref`/`$defs`; the mock generator fails closed on `$ref`
 *
 * Fail-safe: a non-zod value, or an unconvertible schema, returns `undefined` → the schema stays opaque
 * (NO_WITNESS / `{}`), exactly as before this bridge existed.
 */
export function zodJsonSchema(schema: unknown): JsonSchema | undefined {
  if (typeof toJSONSchema !== "function") return undefined
  try {
    const json = toJSONSchema(schema, { target: "draft-7", io: "input", reused: "inline" })
    return json === null || json === undefined ? undefined : (json as JsonSchema)
  } catch {
    return undefined
  }
}

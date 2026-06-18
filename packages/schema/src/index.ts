/**
 * `@nifrajs/schema` — the optional, batteries-included schema builder for nifra.
 *
 * `t` is TypeBox-backed: validators are compiled (fast) and every schema is a JSON
 * Schema (free OpenAPI). It implements Standard Schema, so `@nifrajs/core` validates
 * it through the exact same path as any BYO library — `@nifrajs/core` never depends on
 * a validator; this package is the opt-in default.
 */
export { fromTypeBox, type NifraSchema } from "./adapter.ts"
// Re-exporting evaluates ./formats.ts, registering the standard string formats so
// `t.string({ format })` validates instead of rejecting everything.
export { registerFormat } from "./formats.ts"
export { type OpenAPIDocument, type OpenAPIInfo, toOpenAPI } from "./openapi.ts"
export { t } from "./t.ts"

/**
 * The DEFAULT `reflectJsonSchema` hook: derive the inspectable JSON Schema the mock/mutation generators
 * read from an opaque Standard Schema - with no wiring at all.
 *
 * Standard Schema standardizes validation, not introspection, so an opaque validator normally leaves a
 * route unmockable (`{}`) and unwitnessed (`NO_WITNESS`) unless the caller passes a bridge. Two sources,
 * in order:
 *   1. The schema's own Standard JSON Schema converter (`"~standard".jsonSchema.input`, zod 4.2+ and
 *      other libraries that implement it). The library that built the schema converts it, so nothing is
 *      resolved from disk and a monorepo whose zod sits in one app reads the same as a single package.
 *   2. For a zod schema without that converter, zod's `z.toJSONSchema` (zod 4+), with zod resolved from
 *      the project first, then from this package.
 * Everything about it fails soft: no converter, no zod installed, an older zod without `toJSONSchema`,
 * or a schema the library cannot convert (custom transforms) all return `undefined`, which is exactly
 * the opaque behavior a caller saw before this existed. An explicit `reflectJsonSchema` option always
 * wins over this default.
 *
 * zod stays an OPTIONAL peer: it is loaded lazily via `createRequire` (never a static import), probed
 * once per project directory, and its absence is a cached miss. {@link explainAutoReflectJsonSchema}
 * says why a schema stayed opaque.
 * Conversion options mirror `@nifrajs/testing/zod` (`zodJsonSchema`), which remains the explicit form:
 *   - target draft-07 → the keyword set the mock generator + `candidateMutations` read
 *   - the input side  → the request-side constraints a hostile payload must violate (pre-transform)
 *   - reused "inline" → no `$ref`/`$defs`; the mock generator fails closed on `$ref` (zod only)
 */
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { JsonSchema } from "@nifrajs/core/reflection"

const ZOD_TO_JSON_SCHEMA_OPTIONS = { target: "draft-7", io: "input", reused: "inline" } as const

type ToJSONSchema = (schema: unknown, options?: unknown) => unknown
type ZodProbe = { readonly toJSONSchema: ToJSONSchema } | { readonly reason: string }

/**
 * The directory whose `node_modules/zod` is nearest above `start`, found by walking the filesystem:
 * the project's own zod is the one that built its schemas, and a resolver that memoizes per process
 * would pin the first project's answer.
 */
function projectZodBase(start: string): string | undefined {
  for (let dir = start; ; ) {
    if (existsSync(join(dir, "node_modules", "zod", "package.json")))
      return join(dir, "package.json")
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const probeFrom = (base: string): ZodProbe | undefined => {
  let zod: { readonly toJSONSchema?: unknown }
  try {
    zod = createRequire(base)("zod")
  } catch {
    return undefined
  }
  const toJSONSchema = zod.toJSONSchema
  return typeof toJSONSchema === "function"
    ? { toJSONSchema: (schema, options) => Reflect.apply(toJSONSchema, zod, [schema, options]) }
    : { reason: "the zod installed is older than 4 and has no toJSONSchema" }
}

// Keyed by the project directory, so a long-lived process serving several projects reads each one's zod.
const probes = new Map<string, ZodProbe>()
const probeZod = (): ZodProbe => {
  const cwd = globalThis.process?.cwd?.() ?? ""
  const cached = probes.get(cwd)
  if (cached !== undefined) return cached
  const projectBase = cwd === "" ? undefined : projectZodBase(cwd)
  // A project zod that cannot convert is the answer: a newer copy here could not read its schemas.
  const probe = (projectBase === undefined ? undefined : probeFrom(projectBase)) ??
    probeFrom(import.meta.url) ?? {
      reason: "zod is not resolvable from the project or from @nifrajs/mock",
    }
  probes.set(cwd, probe)
  return probe
}

type AutoReflection = { readonly jsonSchema: JsonSchema } | { readonly reason: string }

// zod's name for the inline-refs option of its converter; other libraries get only the target.
const ZOD_LIBRARY_OPTIONS = { reused: "inline" } as const

/** The schema's own `~standard.jsonSchema.input` result, or `undefined` when it has no converter. */
function reflectStandardJsonSchema(standard: unknown, vendor: unknown): AutoReflection | undefined {
  const converter: unknown = Reflect.get(Object(standard), "jsonSchema")
  const input: unknown = Reflect.get(Object(converter), "input")
  if (typeof input !== "function") return undefined
  const options: { target: string; libraryOptions?: Record<string, unknown> } = {
    target: "draft-07",
  }
  if (vendor === "zod") options.libraryOptions = ZOD_LIBRARY_OPTIONS
  try {
    const json: unknown = Reflect.apply(input, converter, [options])
    return json !== null && typeof json === "object"
      ? { jsonSchema: json as JsonSchema }
      : { reason: `the ${String(vendor)} schema's ~standard.jsonSchema.input returned no schema` }
  } catch (error) {
    return {
      reason: `the ${String(vendor)} schema's ~standard.jsonSchema.input threw: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function reflectAuto(schema: unknown): AutoReflection | undefined {
  const standard: unknown = Reflect.get(Object(schema), "~standard")
  const vendor: unknown = Reflect.get(Object(standard), "vendor")
  const own = reflectStandardJsonSchema(standard, vendor)
  if (own !== undefined) return own
  if (vendor !== "zod") return undefined
  const probe = probeZod()
  if ("reason" in probe) return probe
  try {
    const json = probe.toJSONSchema(schema, ZOD_TO_JSON_SCHEMA_OPTIONS)
    return json === null || json === undefined
      ? { reason: "zod's toJSONSchema returned nothing" }
      : { jsonSchema: json as JsonSchema }
  } catch (error) {
    return {
      reason: `zod's toJSONSchema threw: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Derive a JSON Schema from a Standard Schema's own converter, or from zod for a zod schema without one;
 * `undefined` for anything else (no converter and not zod, zod not installed, unconvertible schemas). Safe as an always-on default: it can only ever turn an
 * opaque schema inspectable, never change one that already carries JSON Schema metadata.
 */
export function autoReflectJsonSchema(schema: unknown): JsonSchema | undefined {
  const reflected = reflectAuto(schema)
  return reflected !== undefined && "jsonSchema" in reflected ? reflected.jsonSchema : undefined
}

/**
 * Why {@link autoReflectJsonSchema} could not read a schema: its converter threw or returned nothing,
 * or, for a zod schema without one, zod is not resolvable or is older than 4. `undefined` for a schema
 * it reads, or one it has no way to read.
 */
export function explainAutoReflectJsonSchema(schema: unknown): string | undefined {
  const reflected = reflectAuto(schema)
  return reflected !== undefined && "reason" in reflected ? reflected.reason : undefined
}

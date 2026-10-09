/**
 * The DEFAULT `reflectJsonSchema` hook: recognize a zod schema by its Standard Schema vendor tag and
 * derive the inspectable JSON Schema the mock/mutation generators read - with no wiring at all.
 *
 * Standard Schema standardizes validation, not introspection, so an opaque validator normally leaves a
 * route unmockable (`{}`) and unwitnessed (`NO_WITNESS`) unless the caller passes a bridge. But every
 * Standard Schema carries `"~standard".vendor`, and zod ships its own converter (`z.toJSONSchema`,
 * zod 4+) - so when the vendor says "zod" and zod is resolvable (from the project first, then from
 * this package), the bridge can be applied
 * automatically. Everything about it fails soft: no zod installed, an older zod without `toJSONSchema`,
 * a non-zod vendor, or a schema zod cannot convert (custom transforms) all return `undefined`, which is
 * exactly the opaque behavior a caller saw before this existed. An explicit `reflectJsonSchema` option
 * always wins over this default.
 *
 * zod stays an OPTIONAL peer: it is loaded lazily via `createRequire` (never a static import), probed
 * once per project directory, and its absence is a cached miss. {@link explainAutoReflectJsonSchema}
 * says why a zod schema stayed opaque.
 * Conversion options mirror `@nifrajs/testing/zod` (`zodJsonSchema`), which remains the explicit form:
 *   - target "draft-7" → the keyword set the mock generator + `candidateMutations` read
 *   - io "input"       → the request-side constraints a hostile payload must violate (pre-transform)
 *   - reused "inline"  → no `$ref`/`$defs`; the mock generator fails closed on `$ref`
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

type ZodReflection = { readonly jsonSchema: JsonSchema } | { readonly reason: string }

function reflectZod(schema: unknown): ZodReflection | undefined {
  const standard: unknown = Reflect.get(Object(schema), "~standard")
  if (Reflect.get(Object(standard), "vendor") !== "zod") return undefined
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
 * Derive a JSON Schema from a zod Standard Schema, or `undefined` for anything else (non-zod vendors,
 * zod not installed, unconvertible schemas). Safe as an always-on default: it can only ever turn an
 * opaque schema inspectable, never change one that already carries JSON Schema metadata.
 */
export function autoReflectJsonSchema(schema: unknown): JsonSchema | undefined {
  const reflected = reflectZod(schema)
  return reflected !== undefined && "jsonSchema" in reflected ? reflected.jsonSchema : undefined
}

/**
 * Why {@link autoReflectJsonSchema} could not read a zod schema: zod is not resolvable, it is older
 * than 4, or its converter threw. `undefined` for a schema it reads, or one that is not zod's.
 */
export function explainAutoReflectJsonSchema(schema: unknown): string | undefined {
  const reflected = reflectZod(schema)
  return reflected !== undefined && "reason" in reflected ? reflected.reason : undefined
}

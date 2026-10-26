import { Kind, OptionalKind, ReadonlyKind, type TSchema } from "@sinclair/typebox"
import { TypeCompiler } from "@sinclair/typebox/compiler"
import { hasCompileHazard, type NifraSchema, validatesByJsonSchemaAlone } from "./adapter.ts"

export interface CompileSchemaOptions {
  /** Type-only import of the source schema, relative to the generated module. */
  readonly source: string
  readonly exportName: string
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const RESERVED = new Set(
  "await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments Kind OptionalKind ReadonlyKind fromPrecompiled format hash SourceSchema jsonSchema check undefined NaN Infinity".split(
    " ",
  ),
)
const SYMBOLS = new Map<symbol, string>([
  [Kind, "Kind"],
  [OptionalKind, "OptionalKind"],
  [ReadonlyKind, "ReadonlyKind"],
])
// TypeBox's TypeScript output annotates the binding of the for-of it emits for an array check, which
// TypeScript refuses (TS2483) and so does Node's type stripping. The array it walks is `any`, which
// types the binding without the annotation.
const ANNOTATED_FOR_OF = "for(const value: any of array)"
const BUILTIN_KINDS = new Set(
  "Any Argument Array AsyncIterator BigInt Boolean Constructor Date Function Import Integer Intersect Iterator Literal Never Not Null Number Object Promise Record Ref RegExp String Symbol TemplateLiteral This Tuple Undefined Union Uint8Array Unknown Void".split(
    " ",
  ),
)

/** `value` as source text; each symbol key it writes is added to `symbols`, for the import line. */
function literal(value: unknown, symbols: Set<string>, active = new Set<object>()): string {
  if (value === undefined) return "undefined"
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value))
    return Object.is(value, -0) ? "-0" : String(value)
  if (typeof value !== "object" || active.has(value))
    throw new Error("[nifra/schema] precompile requires an acyclic, serializable schema")
  active.add(value)
  try {
    if (Array.isArray(value))
      return `[${value.map((item) => literal(item, symbols, active)).join(",")}]`
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error("[nifra/schema] precompile refuses class instances and runtime objects")
    const kind = Object.getOwnPropertyDescriptor(value, Kind)?.value
    if (typeof kind === "string" && !BUILTIN_KINDS.has(kind))
      throw new Error(
        "[nifra/schema] precompile does not support custom registry kinds; use the normal adapter",
      )
    const fields = Reflect.ownKeys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !("value" in descriptor))
        throw new Error("[nifra/schema] precompile refuses schema accessors")
      const symbol = typeof key === "symbol" ? SYMBOLS.get(key) : undefined
      if (typeof key === "symbol" && symbol === undefined)
        throw new Error("[nifra/schema] precompile refuses runtime-only schema metadata")
      if (symbol !== undefined) symbols.add(symbol)
      // Computed keys keep __proto__ as data instead of changing the generated object's prototype.
      return `${symbol === undefined ? `[${JSON.stringify(key)}]` : `[${symbol}]`}:${literal(descriptor.value, symbols, active)}`
    })
    return `{${fields.join(",")}}`
  } finally {
    active.delete(value)
  }
}

/** Generate a typed module with static validation code. Run at build time, then import its export at runtime. */
export function compileSchema<T extends TSchema>(
  schema: NifraSchema<T>,
  options: CompileSchemaOptions,
): string {
  if (
    !IDENTIFIER.test(options.exportName) ||
    RESERVED.has(options.exportName) ||
    options.source.length === 0
  )
    throw new Error("[nifra/schema] precompile requires a source module and an exported identifier")
  if (!validatesByJsonSchemaAlone(schema))
    throw new Error(
      "[nifra/schema] precompile does not support coercing schemas (t.query, t.form, …) or a validate that does more than check jsonSchema; use the normal adapter",
    )
  const symbols = new Set<string>()
  const node = literal(schema.jsonSchema, symbols)
  if (hasCompileHazard(schema.jsonSchema))
    throw new Error(
      "[nifra/schema] precompile refuses keys, literals or format names that the TypeBox compiler cannot escape safely",
    )
  // Only schema text can put the annotated statement in the JavaScript output, and rewriting it there
  // would change what the checker compares.
  if (TypeCompiler.Code(schema.jsonSchema, { language: "javascript" }).includes(ANNOTATED_FOR_OF))
    throw new Error(
      `[nifra/schema] precompile refuses a schema whose text holds ${JSON.stringify(ANNOTATED_FOR_OF)}`,
    )
  const code = TypeCompiler.Code(schema.jsonSchema, { language: "typescript" }).replaceAll(
    ANNOTATED_FOR_OF,
    "for(const value of array)",
  )
  // Every import is used, so the module also passes `noUnusedLocals`.
  const imports = [...symbols, "fromPrecompiled"]
  if (/\bformat\s*\(/.test(code)) imports.push("compiledFormat as format")
  if (/\bhash\s*\(/.test(code)) imports.push("compiledHash as hash")
  return [
    "// Generated by @nifrajs/schema/compile. Do not edit.",
    `import { ${imports.join(", ")} } from "@nifrajs/schema/precompiled"`,
    `import type { ${options.exportName} as SourceSchema } from ${JSON.stringify(options.source)}`,
    `const jsonSchema = ${node}`,
    `const check = (() => {\n${code}\n})()`,
    // A literal lacks TypeBox's phantom `static` and `params`, so it converts to the source type only through `unknown`.
    "// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: The serialized TypeBox nodes and checker came from this exact source schema.",
    `export const ${options.exportName} = fromPrecompiled<(typeof SourceSchema)["jsonSchema"]>(jsonSchema as unknown as (typeof SourceSchema)["jsonSchema"], check)`,
    "",
  ].join("\n")
}

/**
 * Build-time response-type reflection for OpenAPI.
 *
 * This module is CLI-only. It loads the project's TypeScript compiler on demand, inspects the
 * exported `backend` type, and returns inert JSON Schema metadata. It never imports or executes the
 * generated schema at request time, and unsupported/opaque types are omitted rather than guessed.
 */

import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { JsonSchema } from "@nifrajs/core/reflection"
import type * as TSApi from "typescript"
import { importProjectTypeScript, type TypeScriptApi } from "./internal/typescript-import.ts"

export interface InferredOpenAPIResponse {
  readonly description?: string
  readonly schema?: JsonSchema
  readonly contentType?: string
}

export type InferredOpenAPIResponses = Readonly<
  Record<string, Readonly<Record<string, InferredOpenAPIResponse>>>
>

export interface OpenAPITypeInferenceResult {
  readonly responses: InferredOpenAPIResponses
  readonly warnings: readonly string[]
}

type Type = TSApi.Type
type TypeChecker = TSApi.TypeChecker

const hasFlag = (type: Type, flag: number): boolean => (type.flags & flag) !== 0

function schemaForType(
  ts: TypeScriptApi,
  checker: TypeChecker,
  input: Type,
  seen: Set<Type>,
  depth: number,
): JsonSchema | undefined {
  if (depth > 20 || seen.has(input)) return undefined
  // Keep `null` in unions: OpenAPI distinguishes `string | null` from `string`. Undefined members
  // are omitted below because JSON has no undefined value; optional object properties are represented
  // by the property's optional symbol flag instead.
  const type = input
  if (hasFlag(type, ts.TypeFlags.Any) || hasFlag(type, ts.TypeFlags.Unknown)) return undefined
  if (hasFlag(type, ts.TypeFlags.Never)) return undefined
  if (hasFlag(type, ts.TypeFlags.Undefined) || hasFlag(type, ts.TypeFlags.Void)) return undefined
  if (hasFlag(type, ts.TypeFlags.StringLiteral)) {
    return { const: (type as TSApi.StringLiteralType).value }
  }
  if (hasFlag(type, ts.TypeFlags.NumberLiteral)) {
    return { const: (type as TSApi.NumberLiteralType).value }
  }
  if (hasFlag(type, ts.TypeFlags.BooleanLiteral)) {
    return { const: checker.typeToString(type) === "true" }
  }
  if (hasFlag(type, ts.TypeFlags.StringLike)) return { type: "string" }
  if (hasFlag(type, ts.TypeFlags.NumberLike)) return { type: "number" }
  if (hasFlag(type, ts.TypeFlags.BooleanLike)) return { type: "boolean" }
  if (hasFlag(type, ts.TypeFlags.BigIntLike)) return { type: "integer" }
  if (hasFlag(type, ts.TypeFlags.Null)) return { type: "null" }

  if (type.isUnion()) {
    const members = type.types
      .map((member) => schemaForType(ts, checker, member, seen, depth + 1))
      .filter((schema): schema is JsonSchema => schema !== undefined)
    if (members.length === 0) return undefined
    if (members.length === 1) return members[0]
    return { anyOf: members }
  }

  if (checker.isTupleType(type)) {
    const elements = checker
      .getTypeArguments(type as TSApi.TypeReference)
      .map((member) => schemaForType(ts, checker, member, seen, depth + 1))
      .filter((schema): schema is JsonSchema => schema !== undefined)
    return elements.length === 0 ? undefined : { type: "array", prefixItems: elements }
  }
  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type as TSApi.TypeReference)
    const items =
      element === undefined ? undefined : schemaForType(ts, checker, element, seen, depth + 1)
    return items === undefined ? { type: "array" } : { type: "array", items }
  }

  if (type.symbol?.name === "Date") return { type: "string", format: "date-time" }
  if ((type.flags & ts.TypeFlags.Object) === 0) return undefined

  seen.add(type)
  try {
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0]
      if (declaration === undefined) continue
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration)
      // Methods are implementation details, not JSON fields. Other unsupported property types make
      // the whole response opaque instead of emitting a partial schema that could falsely promise a
      // contract to generated clients.
      if (checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call).length > 0) continue
      const propertySchema = schemaForType(ts, checker, propertyType, seen, depth + 1)
      if (propertySchema === undefined) return undefined
      properties[property.name] = propertySchema
      if ((property.flags & ts.SymbolFlags.Optional) === 0) required.push(property.name)
    }
    if (Object.keys(properties).length === 0) return { type: "object" }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
  } finally {
    seen.delete(type)
  }
}

function symbolNamed(
  checker: TypeChecker,
  source: TSApi.SourceFile,
  name: string,
  flags: number,
): TSApi.Symbol | undefined {
  return checker.getSymbolsInScope(source, flags).find((symbol) => symbol.name === name)
}

function propertyType(checker: TypeChecker, type: Type, name: string): Type | undefined {
  const property = type.getProperty(name)
  if (property === undefined) return undefined
  const declaration =
    property.valueDeclaration ?? property.declarations?.[0] ?? type.symbol?.valueDeclaration
  return declaration === undefined
    ? checker.getDeclaredTypeOfSymbol(property)
    : checker.getTypeOfSymbolAtLocation(property, declaration)
}

function responseEntries(
  ts: TypeScriptApi,
  checker: TypeChecker,
  location: TSApi.Node,
  responseMap: Type,
  warnings: string[],
): Record<string, InferredOpenAPIResponse> {
  const output: Record<string, InferredOpenAPIResponse> = {}
  for (const property of responseMap.getProperties()) {
    if (!/^[1-5][0-9]{2}$/.test(property.name)) continue
    const bodyType = checker.getTypeOfSymbolAtLocation(property, location)
    const schema = schemaForType(ts, checker, bodyType, new Set(), 0)
    if (schema === undefined) {
      const bodylessStatus =
        property.name === "204" || property.name === "205" || property.name === "304"
      const bodylessType =
        hasFlag(bodyType, ts.TypeFlags.Undefined) || hasFlag(bodyType, ts.TypeFlags.Void)
      if (bodylessStatus && bodylessType) {
        output[property.name] = {}
        continue
      }
      warnings.push(
        `response ${property.name} has an unsupported or opaque TypeScript body (${checker.typeToString(bodyType)})`,
      )
      continue
    }
    output[property.name] = { schema }
  }
  return output
}

/** Infer response schemas from `<root>/backend.ts` without affecting runtime application loading. */
export async function inferOpenAPIResponses(root: string): Promise<OpenAPITypeInferenceResult> {
  const warnings: string[] = []
  const backendPath = resolve(root, "backend.ts")
  if (!existsSync(backendPath)) return { responses: {}, warnings }

  const ts = await importProjectTypeScript(root)
  if (ts === undefined) {
    warnings.push("TypeScript is not installed; response inference was skipped")
    return { responses: {}, warnings }
  }

  const temp = await mkdtemp(join(tmpdir(), "nifra-openapi-"))
  const probePath = join(temp, "probe.ts")
  const probe = [
    'import type { Server as __NifraServer } from "@nifrajs/core/server"',
    `import { backend as __nifra_backend } from ${JSON.stringify(backendPath)}`,
    "type __NifraRegistry = typeof __nifra_backend extends __NifraServer<infer R, any, any> ? R : never",
    "declare const __nifra_registry: __NifraRegistry",
  ].join("\n")

  try {
    await writeFile(probePath, probe, "utf8")
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")
    let options: TSApi.CompilerOptions = {
      noEmit: true,
      skipLibCheck: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    }
    let fileNames = [backendPath]
    if (configPath !== undefined) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile)
      if (config.error) {
        warnings.push(
          `could not read tsconfig.json: ${ts.flattenDiagnosticMessageText(config.error.messageText, " ")}`,
        )
      } else {
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
        options = { ...parsed.options, noEmit: true, skipLibCheck: true }
        fileNames = parsed.fileNames.length > 0 ? parsed.fileNames : fileNames
      }
    }
    const host = ts.createCompilerHost(options, true)
    const program = ts.createProgram(
      [...new Set([...fileNames, backendPath, probePath])],
      options,
      host,
    )
    const source = program.getSourceFile(probePath)
    if (source === undefined) {
      warnings.push("could not create the TypeScript response-inference probe")
      return { responses: {}, warnings }
    }
    const checker = program.getTypeChecker()
    const registrySymbol = symbolNamed(
      checker,
      source,
      "__nifra_registry",
      ts.SymbolFlags.BlockScopedVariable,
    )
    if (registrySymbol === undefined) {
      warnings.push("backend does not expose a typed Nifra server registry")
      return { responses: {}, warnings }
    }
    const registry = checker.getTypeOfSymbolAtLocation(registrySymbol, source)
    const responses: Record<string, Record<string, InferredOpenAPIResponse>> = {}
    for (const pathSymbol of registry.getProperties()) {
      const routePath = pathSymbol.name
      const methods = checker.getTypeOfSymbolAtLocation(pathSymbol, source)
      for (const methodSymbol of methods.getProperties()) {
        if (methodSymbol.name === "WS") continue
        const info = checker.getTypeOfSymbolAtLocation(methodSymbol, source)
        const responseType = propertyType(checker, info, "responses")
        if (responseType === undefined) continue
        const routeResponses = responseEntries(
          ts,
          checker,
          source,
          checker.getNonNullableType(responseType),
          warnings,
        )
        if (Object.keys(routeResponses).length > 0) {
          responses[`${methodSymbol.name.toUpperCase()} ${routePath}`] = routeResponses
        }
      }
    }
    return { responses, warnings }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

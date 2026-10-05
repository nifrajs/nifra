/**
 * Build-time response-type reflection for OpenAPI.
 *
 * This module is CLI-only. It loads the project's TypeScript compiler on demand, inspects the
 * exported `backend` type, and returns inert JSON Schema metadata. It never imports or executes the
 * generated schema at request time, and unsupported/opaque types are omitted rather than guessed.
 */

import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type { JsonSchema } from "@nifrajs/core/reflection"
import type * as TSApi from "typescript"
import { BACKEND_APP_FILE } from "./app-files.ts"
import {
  loadProjectTypeScript,
  type TypeScriptApi,
  type TypeScriptSemanticSession,
  type TypeScriptSession,
} from "./internal/typescript-import.ts"

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

interface TypeScript7Node {
  readonly kind: number
  readonly pos: number
  readonly end: number
  getStart(sourceFile?: TypeScript7SourceFile): number
  getText(sourceFile?: TypeScript7SourceFile): string
}

interface TypeScript7SourceFile extends TypeScript7Node {
  readonly fileName: string
}

interface TypeScript7Symbol {
  readonly name: string
  readonly flags: number
}

interface TypeScript7Type {
  readonly flags: number
  readonly value?: string | number | boolean | bigint
  getTypes(): Promise<readonly TypeScript7Type[] | undefined>
  getSymbol(): Promise<TypeScript7Symbol | undefined>
}

interface TypeScript7Checker {
  getTypeAtPosition(file: string, position: number): Promise<TypeScript7Type | undefined>
  getTypeOfSymbol(symbol: TypeScript7Symbol): Promise<TypeScript7Type | undefined>
  getTypeOfSymbolAtLocation(
    symbol: TypeScript7Symbol,
    location: TypeScript7Node,
  ): Promise<TypeScript7Type>
  getPropertiesOfType(type: TypeScript7Type): Promise<readonly TypeScript7Symbol[]>
  getPropertyOfType(type: TypeScript7Type, name: string): Promise<TypeScript7Symbol | undefined>
  getDeclaredTypeOfSymbol(symbol: TypeScript7Symbol): Promise<TypeScript7Type>
  getApparentType(type: TypeScript7Type): Promise<TypeScript7Type | undefined>
  getSignaturesOfType(type: TypeScript7Type, kind: number): Promise<readonly unknown[]>
  getTypeArguments(type: TypeScript7Type): Promise<readonly TypeScript7Type[]>
  getNonNullableType(type: TypeScript7Type): Promise<TypeScript7Type | undefined>
  typeToString(type: TypeScript7Type): Promise<string>
  isTupleType(type: TypeScript7Type): Promise<boolean>
  isArrayType(type: TypeScript7Type): Promise<boolean>
}

const semanticChecker = async (
  semantic: TypeScriptSemanticSession,
  file: string,
): Promise<TypeScript7Checker> =>
  ((await semantic.getCheckerForFile(file)) ?? semantic.checker) as TypeScript7Checker

const semanticSource = async (
  semantic: TypeScriptSemanticSession,
  file: string,
): Promise<TypeScript7SourceFile | undefined> =>
  (await semantic.getSourceFile(file)) as TypeScript7SourceFile | undefined

function semanticFlag(semantic: TypeScriptSemanticSession, name: string): number {
  const value = semantic.typeFlags[name]
  if (typeof value !== "number") throw new Error(`TypeScript 7 TypeFlags.${name} is unavailable`)
  return value
}

function semanticSymbolFlag(semantic: TypeScriptSemanticSession, name: string): number {
  const value = semantic.symbolFlags[name]
  if (typeof value !== "number") throw new Error(`TypeScript 7 SymbolFlags.${name} is unavailable`)
  return value
}

function semanticSignatureKind(semantic: TypeScriptSemanticSession, name: string): number {
  const value = semantic.signatureKind[name]
  if (typeof value !== "number")
    throw new Error(`TypeScript 7 SignatureKind.${name} is unavailable`)
  return value
}

async function schemaForType7(
  semantic: TypeScriptSemanticSession,
  checker: TypeScript7Checker,
  input: TypeScript7Type,
  seen: Set<TypeScript7Type>,
  depth: number,
): Promise<JsonSchema | undefined> {
  if (depth > 20 || seen.has(input)) return undefined
  const anyFlag = semanticFlag(semantic, "Any")
  const unknownFlag = semanticFlag(semantic, "Unknown")
  const neverFlag = semanticFlag(semantic, "Never")
  const undefinedFlag = semanticFlag(semantic, "Undefined")
  const voidFlag = semanticFlag(semantic, "Void")
  const stringLiteralFlag = semanticFlag(semantic, "StringLiteral")
  const numberLiteralFlag = semanticFlag(semantic, "NumberLiteral")
  const booleanLiteralFlag = semanticFlag(semantic, "BooleanLiteral")
  const stringLikeFlag = semanticFlag(semantic, "StringLike")
  const numberLikeFlag = semanticFlag(semantic, "NumberLike")
  const booleanLikeFlag = semanticFlag(semantic, "BooleanLike")
  const bigintLikeFlag = semanticFlag(semantic, "BigIntLike")
  const nullFlag = semanticFlag(semantic, "Null")
  const unionFlag = semanticFlag(semantic, "Union")
  const objectFlag = semanticFlag(semantic, "Object")

  if ((input.flags & (anyFlag | unknownFlag)) !== 0) return undefined
  if ((input.flags & neverFlag) !== 0) return undefined
  if ((input.flags & (undefinedFlag | voidFlag)) !== 0) return undefined
  if ((input.flags & stringLiteralFlag) !== 0 && typeof input.value === "string") {
    return { const: input.value }
  }
  if ((input.flags & numberLiteralFlag) !== 0 && typeof input.value === "number") {
    return { const: input.value }
  }
  if ((input.flags & booleanLiteralFlag) !== 0) {
    return { const: (await checker.typeToString(input)) === "true" }
  }
  if ((input.flags & stringLikeFlag) !== 0) return { type: "string" }
  if ((input.flags & numberLikeFlag) !== 0) return { type: "number" }
  if ((input.flags & booleanLikeFlag) !== 0) return { type: "boolean" }
  if ((input.flags & bigintLikeFlag) !== 0) return { type: "integer" }
  if ((input.flags & nullFlag) !== 0) return { type: "null" }

  if ((input.flags & unionFlag) !== 0) {
    const members = (await input.getTypes()) ?? []
    const schemas = (
      await Promise.all(
        members.map((member) => schemaForType7(semantic, checker, member, seen, depth + 1)),
      )
    ).filter((schema): schema is JsonSchema => schema !== undefined)
    if (schemas.length === 0) return undefined
    if (schemas.length === 1) return schemas[0]
    return { anyOf: schemas }
  }

  if (await checker.isTupleType(input)) {
    const elements = (
      await Promise.all(
        (
          await checker.getTypeArguments(input)
        ).map((member) => schemaForType7(semantic, checker, member, seen, depth + 1)),
      )
    ).filter((schema): schema is JsonSchema => schema !== undefined)
    return elements.length === 0 ? undefined : { type: "array", prefixItems: elements }
  }
  if (await checker.isArrayType(input)) {
    const [element] = await checker.getTypeArguments(input)
    const items =
      element === undefined
        ? undefined
        : await schemaForType7(semantic, checker, element, seen, depth + 1)
    return items === undefined ? { type: "array" } : { type: "array", items }
  }

  const symbol = await input.getSymbol()
  if (symbol?.name === "Date") return { type: "string", format: "date-time" }
  if ((input.flags & objectFlag) === 0) return undefined

  seen.add(input)
  try {
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const property of await checker.getPropertiesOfType(input)) {
      const propertyType = await checker.getTypeOfSymbol(property)
      if (propertyType === undefined) return undefined
      if (
        (await checker.getSignaturesOfType(propertyType, semanticSignatureKind(semantic, "Call")))
          .length > 0
      )
        continue
      const propertySchema = await schemaForType7(semantic, checker, propertyType, seen, depth + 1)
      if (propertySchema === undefined) return undefined
      properties[property.name] = propertySchema
      if ((property.flags & semanticSymbolFlag(semantic, "Optional")) === 0) {
        required.push(property.name)
      }
    }
    if (Object.keys(properties).length === 0) return { type: "object" }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
  } finally {
    seen.delete(input)
  }
}

async function inferOpenAPIResponses7(
  semantic: TypeScriptSemanticSession,
  probePath: string,
  warnings: string[],
): Promise<OpenAPITypeInferenceResult> {
  const source = await semanticSource(semantic, probePath)
  if (source === undefined) {
    warnings.push("could not create the TypeScript 7 response-inference probe")
    return { responses: {}, warnings }
  }
  const checker = await semanticChecker(semantic, probePath)
  const registryPosition = source.getText().indexOf("__nifra_registry")
  if (registryPosition < 0) {
    warnings.push("backend does not expose a typed Nifra server registry")
    return { responses: {}, warnings }
  }
  const registry = await checker.getTypeAtPosition(probePath, registryPosition)
  if (registry === undefined) {
    warnings.push("backend does not expose a typed Nifra server registry")
    return { responses: {}, warnings }
  }
  const responses: Record<string, Record<string, InferredOpenAPIResponse>> = {}
  for (const pathSymbol of await checker.getPropertiesOfType(registry)) {
    const methods = await checker.getTypeOfSymbol(pathSymbol)
    if (methods === undefined) continue
    for (const methodSymbol of await checker.getPropertiesOfType(methods)) {
      if (methodSymbol.name === "WS") continue
      const info = await checker.getTypeOfSymbol(methodSymbol)
      if (info === undefined) continue
      const responseSymbol = await checker.getPropertyOfType(info, "responses")
      if (responseSymbol === undefined) continue
      const responseType = await checker.getTypeOfSymbol(responseSymbol)
      if (responseType === undefined) continue
      const nonNullable = await checker.getNonNullableType(responseType)
      if (nonNullable === undefined) continue
      const routeResponses: Record<string, InferredOpenAPIResponse> = {}
      const responseMap = (await checker.getApparentType(nonNullable)) ?? nonNullable
      for (const property of await checker.getPropertiesOfType(responseMap)) {
        if (!/^[1-5][0-9]{2}$/.test(property.name)) continue
        const bodyType = await checker.getTypeOfSymbol(property)
        if (bodyType === undefined) continue
        const schema = await schemaForType7(semantic, checker, bodyType, new Set(), 0)
        if (schema === undefined) {
          const bodylessStatus = ["204", "205", "304"].includes(property.name)
          const bodylessType =
            (bodyType.flags &
              (semanticFlag(semantic, "Undefined") | semanticFlag(semantic, "Void"))) !==
            0
          if (bodylessStatus && bodylessType) {
            routeResponses[property.name] = {}
            continue
          }
          warnings.push(
            `response ${property.name} has an unsupported or opaque TypeScript body (${await checker.typeToString(bodyType)})`,
          )
          continue
        }
        routeResponses[property.name] = { schema }
      }
      if (Object.keys(routeResponses).length > 0) {
        responses[`${methodSymbol.name.toUpperCase()} ${pathSymbol.name}`] = routeResponses
      }
    }
  }
  return { responses, warnings }
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

/** Infer response schemas from `<root>/backend/app.ts` without affecting runtime application
 * loading. */
export async function inferOpenAPIResponses(root: string): Promise<OpenAPITypeInferenceResult> {
  const warnings: string[] = []
  const backendPath = resolve(root, BACKEND_APP_FILE)
  if (!existsSync(backendPath)) return { responses: {}, warnings }

  // TypeScript 7's project checker only resolves node handles inside a configured project's root.
  // Keep both the probe and a short-lived extending config at the project root, then remove them.
  const temp = await mkdtemp(join(root, ".nifra-openapi-"))
  const tempName = basename(temp)
  const probePath = join(root, `.${tempName}.ts`)
  const probeConfigPath = join(root, `.${tempName}.tsconfig.json`)
  const probe = [
    'import type { Server as __NifraServer } from "@nifrajs/core/server"',
    `import { backend as __nifra_backend } from ${JSON.stringify(backendPath)}`,
    "type __NifraRegistry = typeof __nifra_backend extends __NifraServer<infer R, any, any> ? R : never",
    "declare const __nifra_registry: __NifraRegistry",
  ].join("\n")
  let session: TypeScriptSession | undefined

  try {
    await writeFile(probePath, probe, "utf8")
    await writeFile(
      probeConfigPath,
      JSON.stringify(
        existsSync(join(root, "tsconfig.json"))
          ? {
              extends: "./tsconfig.json",
              compilerOptions: { allowImportingTsExtensions: true },
              include: [BACKEND_APP_FILE, basename(probePath)],
            }
          : {
              compilerOptions: {
                module: "ESNext",
                moduleResolution: "Bundler",
                allowImportingTsExtensions: true,
                skipLibCheck: true,
              },
              include: [BACKEND_APP_FILE, basename(probePath)],
            },
      ),
      "utf8",
    )
    const backendContent = await Bun.file(backendPath).text()
    const contents = new Map<string, string>([
      [backendPath, backendContent],
      [probePath, probe],
    ])
    const loaded = await loadProjectTypeScript(root, undefined, {
      files: [backendPath, probePath],
      read: (file) => contents.get(resolve(file)),
      projectConfig: probeConfigPath,
    })
    session = loaded.session
    if (loaded.unsupported !== undefined) {
      warnings.push(
        `TypeScript ${loaded.unsupported.version} is outside the supported OpenAPI reflection API`,
      )
      return { responses: {}, warnings }
    }
    const ts = loaded.compiler
    if (ts === undefined) {
      warnings.push("TypeScript is not installed; response inference was skipped")
      return { responses: {}, warnings }
    }
    if (loaded.session?.semantic !== undefined) {
      return await inferOpenAPIResponses7(loaded.session.semantic, probePath, warnings)
    }
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
    await session?.close()
    await rm(probePath, { force: true })
    await rm(probeConfigPath, { force: true })
    await rm(temp, { recursive: true, force: true })
  }
}

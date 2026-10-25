/**
 * Output schemas from a route's own return types. `loaderOutput` and `actionOutput` stay the reviewed
 * allow-list of what reaches the browser: nothing here runs at request time, and no schema is derived
 * implicitly. `nifra schemas` reads each loader's and action's TypeScript return type, writes a
 * schema for review where a route has none, keeps the schemas it wrote current, and names the
 * returned fields a hand-written schema drops. `nifra check` (NF-C033) fails on a generated schema
 * whose route has changed what it returns since.
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { isSensitiveFieldName } from "@nifrajs/web/zones"
import type * as TSApi from "typescript"
import { codePositionMask } from "./check-scan.ts"
import { codeUnitOrder } from "./internal/code-unit-order.ts"
import {
  loadProjectTypeScript,
  type TypeScriptApi,
  type TypeScriptSemanticSession,
} from "./internal/typescript-import.ts"
import { exported, expressionEnd } from "./rules/data-guard.ts"

export type RouteFn = "loader" | "action"
export type OutputExport = "loaderOutput" | "actionOutput"

const PAIRS: ReadonlyArray<readonly [RouteFn, OutputExport]> = [
  ["loader", "loaderOutput"],
  ["action", "actionOutput"],
]

/** The comment that marks a schema `nifra schemas` wrote, with the hash of what it wrote. */
export const GENERATED_MARK = "nifra:generated"
const MARKER = /^[ \t]*\/\/ nifra:generated ([0-9a-f]{8})\b/

/** A JSON-side reading of a TypeScript type: what a schema for it would have to describe. */
export type Shape =
  | { readonly kind: "string" | "number" | "boolean" | "null" | "date" | "undefined" | "never" }
  | { readonly kind: "json"; readonly reason?: string }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "array"; readonly items: Shape }
  | { readonly kind: "tuple"; readonly items: readonly Shape[] }
  | { readonly kind: "object"; readonly fields: readonly Field[] }
  | { readonly kind: "record"; readonly values: Shape }
  | { readonly kind: "union"; readonly members: readonly Shape[] }
  | { readonly kind: "deferred"; readonly value: Shape }
  | { readonly kind: "opaque"; readonly what: string }

export interface Field {
  readonly name: string
  readonly optional: boolean
  readonly shape: Shape
}

const FLAG_NAMES = [
  "Any",
  "Unknown",
  "Never",
  "Undefined",
  "Void",
  "Null",
  "StringLiteral",
  "NumberLiteral",
  "BooleanLiteral",
  "StringLike",
  "NumberLike",
  "BooleanLike",
  "BigIntLike",
  "ESSymbolLike",
  "Union",
  "Intersection",
  "Object",
  "NonPrimitive",
] as const
type Flags = Readonly<Record<(typeof FLAG_NAMES)[number], number>>

const flagsFrom = (read: (name: string) => unknown): Flags => {
  const at = (name: (typeof FLAG_NAMES)[number]): number => {
    const value = read(name)
    return typeof value === "number" ? value : 0
  }
  return {
    Any: at("Any"),
    Unknown: at("Unknown"),
    Never: at("Never"),
    Undefined: at("Undefined"),
    Void: at("Void"),
    Null: at("Null"),
    StringLiteral: at("StringLiteral"),
    NumberLiteral: at("NumberLiteral"),
    BooleanLiteral: at("BooleanLiteral"),
    StringLike: at("StringLike"),
    NumberLike: at("NumberLike"),
    BooleanLike: at("BooleanLike"),
    BigIntLike: at("BigIntLike"),
    ESSymbolLike: at("ESSymbolLike"),
    Union: at("Union"),
    Intersection: at("Intersection"),
    Object: at("Object"),
    NonPrimitive: at("NonPrimitive"),
  }
}

interface Property<T> {
  readonly name: string
  readonly optional: boolean
  readonly type: T
}

/** The checker calls the walker needs, over TypeScript 5/6's synchronous API or 7's asynchronous one. */
interface TypeReader<T> {
  readonly flag: Flags
  flags(type: T): number
  members(type: T): Promise<readonly T[]>
  symbolName(type: T): Promise<string | undefined>
  aliasName(type: T): Promise<string | undefined>
  literal(type: T): Promise<string | number | boolean | undefined>
  arrayElement(type: T): Promise<T | undefined>
  tupleElements(type: T): Promise<readonly T[] | undefined>
  typeArguments(type: T): Promise<readonly T[]>
  properties(type: T): Promise<readonly Property<T>[]>
  stringIndex(type: T): Promise<T | undefined>
  callable(type: T): Promise<boolean>
  text(type: T): Promise<string>
}

const MAX_DEPTH = 12
const JSON_ALIASES = new Set(["JsonValue", "JSONValue", "Json"])
const NOT_JSON = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "RegExp",
  "Error",
  "Promise",
  "URL",
  "URLSearchParams",
  "Headers",
  "Request",
  "Response",
  "Blob",
  "File",
  "FormData",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "ReadableStream",
  "WritableStream",
  "Function",
])
const TYPED_ARRAY = /^(?:Big)?(?:Int|Uint|Float)(?:8|16|32|64)(?:Clamped)?Array$/

const sameShape = (a: Shape, b: Shape): boolean => JSON.stringify(a) === JSON.stringify(b)

function unionOf(input: readonly Shape[]): Shape {
  const flat = input
    .flatMap((member) => (member.kind === "union" ? member.members : [member]))
    .filter((member) => member.kind !== "never")
  const json = flat.find((member) => member.kind === "json")
  if (json !== undefined) return json
  const isBool = (member: Shape): boolean =>
    member.kind === "literal" && typeof member.value === "boolean"
  const both =
    flat.some((m) => m.kind === "literal" && m.value === true) &&
    flat.some((m) => m.kind === "literal" && m.value === false)
  const members: Shape[] = []
  for (const member of flat) {
    const next: Shape = both && isBool(member) ? { kind: "boolean" } : member
    if (!members.some((seen) => sameShape(seen, next))) members.push(next)
  }
  if (members.length === 0) return { kind: "never" }
  if (members.length === 1 && members[0] !== undefined) return members[0]
  // TypeScript versions order union members differently; a canonical order keeps the generated text,
  // and the hash in its marker, the same under each. `null` reads best last.
  const rank = (shape: Shape): string =>
    `${shape.kind === "null" || shape.kind === "undefined" ? 1 : 0}${JSON.stringify(shape)}`
  return { kind: "union", members: members.sort((a, b) => codeUnitOrder(rank(a), rank(b))) }
}

function withoutUndefined(shape: Shape): Shape {
  if (shape.kind !== "union" || !shape.members.some((member) => member.kind === "undefined"))
    return shape
  return unionOf(shape.members.filter((member) => member.kind !== "undefined"))
}

async function shapeOf<T>(
  reader: TypeReader<T>,
  type: T,
  seen: Set<T>,
  depth: number,
): Promise<Shape> {
  if (depth > MAX_DEPTH) return { kind: "json", reason: "nested too deep to read" }
  const f = reader.flag
  const flags = reader.flags(type)
  const is = (mask: number): boolean => (flags & mask) !== 0
  if (is(f.Any)) return { kind: "json", reason: "any" }
  if (is(f.Unknown)) return { kind: "json", reason: "unknown" }
  if (is(f.Never)) return { kind: "never" }
  if (is(f.Undefined | f.Void)) return { kind: "undefined" }
  if (is(f.Null)) return { kind: "null" }
  if (is(f.StringLiteral | f.NumberLiteral | f.BooleanLiteral)) {
    const value = await reader.literal(type)
    if (value !== undefined) return { kind: "literal", value }
  }
  if (is(f.StringLike)) return { kind: "string" }
  if (is(f.NumberLike)) return { kind: "number" }
  // `boolean` is the union `true | false` with the Boolean flag, so this precedes the union branch.
  if (is(f.BooleanLike)) return { kind: "boolean" }
  if (is(f.BigIntLike)) return { kind: "opaque", what: "a bigint" }
  if (is(f.ESSymbolLike)) return { kind: "opaque", what: "a symbol" }
  const alias = await reader.aliasName(type)
  if (alias !== undefined && JSON_ALIASES.has(alias)) return { kind: "json" }
  if (is(f.Union)) {
    const members = await reader.members(type)
    return unionOf(
      await Promise.all(members.map((member) => shapeOf(reader, member, seen, depth + 1))),
    )
  }
  if (seen.has(type)) return { kind: "json", reason: "a recursive type" }
  if (is(f.Intersection)) {
    // A branded primitive (`string & { __brand: "Id" }`) crosses the wire as the primitive.
    for (const part of await reader.members(type)) {
      if ((reader.flags(part) & (f.StringLike | f.NumberLike | f.BooleanLike)) !== 0)
        return shapeOf(reader, part, seen, depth + 1)
    }
  }
  if (!is(f.Object | f.Intersection | f.NonPrimitive))
    return { kind: "opaque", what: await reader.text(type) }
  const tuple = await reader.tupleElements(type)
  if (tuple !== undefined) {
    return {
      kind: "tuple",
      items: await Promise.all(tuple.map((item) => shapeOf(reader, item, seen, depth + 1))),
    }
  }
  const element = await reader.arrayElement(type)
  if (element !== undefined)
    return { kind: "array", items: await shapeOf(reader, element, seen, depth + 1) }
  const name = await reader.symbolName(type)
  if (name === "Date") return { kind: "date" }
  if (name !== undefined && (NOT_JSON.has(name) || TYPED_ARRAY.test(name)))
    return { kind: "opaque", what: `a ${name}` }
  if (await reader.callable(type)) return { kind: "opaque", what: "a function" }
  seen.add(type)
  try {
    const properties = await reader.properties(type)
    // A `Response`, or nifra's own response carrier (`redirect()`, `status()`): control flow, not data.
    if (properties.some((property) => property.name === "toResponse"))
      return { kind: "opaque", what: "a Response" }
    const promise = properties.find((property) => property.name === "promise")
    if (promise !== undefined && properties.some((p) => p.name === "__nifra_deferred")) {
      const [inner] = await reader.typeArguments(promise.type)
      return {
        kind: "deferred",
        value:
          inner === undefined
            ? { kind: "json", reason: "unknown" }
            : await shapeOf(reader, inner, seen, depth + 1),
      }
    }
    const index = await reader.stringIndex(type)
    if (index !== undefined && properties.length === 0)
      return { kind: "record", values: await shapeOf(reader, index, seen, depth + 1) }
    const fields: Field[] = []
    for (const property of properties) {
      if (property.name.startsWith("__@") || (await reader.callable(property.type))) continue
      const shape = await shapeOf(reader, property.type, seen, depth + 1)
      // `key?: undefined` is how TypeScript lines up a union of object literals: a key the other
      // members have and this one never sends.
      if (shape.kind === "undefined" || shape.kind === "never") continue
      const defined = withoutUndefined(shape)
      fields.push({
        name: property.name,
        optional: property.optional || defined !== shape,
        shape: defined,
      })
    }
    return { kind: "object", fields }
  } finally {
    seen.delete(type)
  }
}

/** What a loader's return type sends: control-flow returns (nothing, a `Response`) carry no data. */
function dataShape(shape: Shape): Shape {
  const members = shape.kind === "union" ? shape.members : [shape]
  return unionOf(
    members.filter(
      (member) =>
        member.kind !== "undefined" && !(member.kind === "opaque" && member.what === "a Response"),
    ),
  )
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const note = (text: string): string => text.replaceAll("*/", "* /")

/** `shape` as `t.*` source, objects one field per line below `indent`. */
export function schemaSource(shape: Shape, indent = ""): string {
  switch (shape.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "date":
      return `t.${shape.kind}()`
    case "undefined":
    case "never":
      return "t.null()"
    case "json":
      return shape.reason === undefined
        ? "t.json()"
        : `t.json() /* ${note(shape.reason)} in the source type */`
    case "opaque":
      return `t.json() /* ${note(shape.what)}, which is not JSON */`
    case "literal":
      return `t.literal(${JSON.stringify(shape.value)})`
    case "array":
      return `t.array(${schemaSource(shape.items, indent)})`
    case "tuple":
      return `t.array(${schemaSource(unionOf(shape.items), indent)})`
    case "record":
      return `t.record(${schemaSource(shape.values, indent)})`
    case "deferred":
      return `t.deferred(${schemaSource(shape.value, indent)})`
    case "union":
      return `t.union([${shape.members.map((member) => schemaSource(member, indent)).join(", ")}])`
    case "object": {
      if (shape.fields.length === 0) return "t.object({})"
      const inner = `${indent}  `
      const lines = shape.fields.map((field) => {
        const key = IDENTIFIER.test(field.name) ? field.name : JSON.stringify(field.name)
        if (isSensitiveFieldName(field.name))
          return `${inner}// left out: ${key} - a credential-like name; declare it with t.declassified("why", ...) if it must reach the browser`
        if (field.shape.kind === "opaque")
          return `${inner}// left out: ${key} - ${note(field.shape.what)}, which is not JSON`
        const value = schemaSource(field.shape, inner)
        return `${inner}${key}: ${field.optional ? `t.optional(${value})` : value},`
      })
      return `t.object({\n${lines.join("\n")}\n${indent}})`
    }
  }
}

/** The paths a draft of `shape` leaves out: credential-like names, and values that are not JSON. */
export function omittedPaths(shape: Shape, path = ""): string[] {
  switch (shape.kind) {
    case "array":
      return omittedPaths(shape.items, `${path}[]`)
    case "tuple":
      return omittedPaths(unionOf(shape.items), `${path}[]`)
    case "record":
      return omittedPaths(shape.values, `${path}{}`)
    case "deferred":
      return omittedPaths(shape.value, path)
    case "union":
      return [...new Set(shape.members.flatMap((member) => omittedPaths(member, path)))]
    case "object":
      return shape.fields.flatMap((field) => {
        const at = path === "" ? field.name : `${path}.${field.name}`
        return isSensitiveFieldName(field.name) || field.shape.kind === "opaque"
          ? [at]
          : omittedPaths(field.shape, at)
      })
    default:
      return []
  }
}

/** The paths a draft of `shape` admits any value at: `any` or `unknown` there, or a type too deep or
 * recursive to read. The output guard drops nothing below them. */
export function openPaths(shape: Shape, path = ""): string[] {
  switch (shape.kind) {
    case "json":
      return shape.reason === undefined ? [] : [path === "" ? "(the whole value)" : path]
    case "array":
      return openPaths(shape.items, `${path}[]`)
    case "tuple":
      return openPaths(unionOf(shape.items), `${path}[]`)
    case "record":
      return openPaths(shape.values, `${path}{}`)
    case "deferred":
      return openPaths(shape.value, path)
    case "union":
      return [...new Set(shape.members.flatMap((member) => openPaths(member, path)))]
    case "object":
      return shape.fields.flatMap((field) =>
        isSensitiveFieldName(field.name) || field.shape.kind === "opaque"
          ? []
          : openPaths(field.shape, path === "" ? field.name : `${path}.${field.name}`),
      )
    default:
      return []
  }
}

/**
 * The paths `returned` carries that `declared` does not, as `a.b`, `items[].c`: what the output guard
 * drops before the page renders. A declared `t.json()` or record admits everything below it.
 */
export function undeclaredPaths(returned: Shape, declared: Shape, path = ""): string[] {
  if (declared.kind === "json" || declared.kind === "record") return []
  if (returned.kind === "union") {
    const found = returned.members.flatMap((member) => undeclaredPaths(member, declared, path))
    return [...new Set(found)]
  }
  if (declared.kind === "union") {
    const candidates = declared.members.filter((m) => m.kind !== "null" && m.kind !== "undefined")
    if (candidates.some((m) => m.kind === "json" || m.kind === "record")) return []
    const results = candidates.map((candidate) => undeclaredPaths(returned, candidate, path))
    const [first, ...rest] = results
    return first === undefined ? [] : first.filter((p) => rest.every((r) => r.includes(p)))
  }
  if (returned.kind === "deferred")
    return undeclaredPaths(
      returned.value,
      declared.kind === "deferred" ? declared.value : declared,
      path,
    )
  if (declared.kind === "deferred") return undeclaredPaths(returned, declared.value, path)
  const items = (shape: Shape): Shape | undefined =>
    shape.kind === "array" ? shape.items : shape.kind === "tuple" ? unionOf(shape.items) : undefined
  const returnedItems = items(returned)
  const declaredItems = items(declared)
  if (returnedItems !== undefined && declaredItems !== undefined)
    return undeclaredPaths(returnedItems, declaredItems, `${path}[]`)
  if (returned.kind !== "object" || declared.kind !== "object") return []
  const found: string[] = []
  for (const field of returned.fields) {
    const at = path === "" ? field.name : `${path}.${field.name}`
    const match = declared.fields.find((candidate) => candidate.name === field.name)
    if (match === undefined) found.push(at)
    else found.push(...undeclaredPaths(field.shape, match.shape, at))
  }
  return found
}

const hashOf = (body: string): string => createHash("sha256").update(body).digest("hex").slice(0, 8)

/**
 * A schema expression as a formatter cannot change it: comments, whitespace, a comma before a closing
 * bracket and a trailing semicolon dropped, every string written with double quotes, and a quoted key
 * that needs no quotes written bare. Two texts
 * that read the same here are the same schema; an edit to what it declares is not.
 */
function schemaTokens(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i)
      i = end === -1 ? text.length : end
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (c === '"' || c === "'" || c === "`") {
      let value = ""
      let j = i + 1
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") {
          const next = text[j + 1] ?? ""
          value += next === c ? next : `\\${next}`
          j += 2
        } else {
          value += text[j]
          j++
        }
      }
      i = j + 1
      let after = i
      while (/\s/.test(text[after] ?? "")) after++
      // `"name": …` and `name: …` declare the same key.
      out +=
        text[after] === ":" && IDENTIFIER.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`
    } else {
      if (!/\s/.test(c)) out += c
      i++
    }
  }
  return out.replace(/,(?=[}\])])/g, "").replace(/(?<!;);+$/, "")
}

function declarationText(schema: OutputExport, fn: RouteFn, body: string): string {
  return [
    `// ${GENERATED_MARK} ${hashOf(body)} - drafted from the ${fn}'s return type; review that the browser may see every field it declares. \`nifra schemas --write\` keeps it current; delete this line to edit it by hand.`,
    `export const ${schema} = ${body}`,
  ].join("\n")
}

// ---- reading the types -------------------------------------------------------------------------

interface ProbeRoute {
  readonly file: string
  readonly fns: readonly RouteFn[]
  readonly schemas: readonly OutputExport[]
  /** Holes whose `boundaryLoaders` entry's `load` return type to read. */
  readonly holes?: readonly string[]
}

/** Shapes keyed `<file>#<export>`: a route function's return type, or a schema's output type. */
interface ProbeResult {
  readonly shapes: ReadonlyMap<string, Shape>
  readonly warnings: readonly string[]
}

const posix = (path: string): string => path.replaceAll("\\", "/")

const PROBE_HELPERS = [
  "type __NifraReturned<M, F extends string> = M extends { readonly [K in F]: (...args: any) => infer R } ? Awaited<R> : never",
  'type __NifraDeclared<M, N extends string> = M extends { readonly [K in N]: infer S } ? S extends { readonly "~standard": { readonly types?: infer T } } ? NonNullable<T> extends { readonly output: infer O } ? O : never : never : never',
]

function probeSource(routes: readonly ProbeRoute[]): {
  readonly text: string
  readonly names: ReadonlyMap<string, string>
} {
  const lines = [...PROBE_HELPERS]
  const names = new Map<string, string>()
  routes.forEach((route, i) => {
    const rel = posix(route.file)
    lines.push(
      `import type * as __nifra_m${i} from ${JSON.stringify(rel.startsWith(".") ? rel : `./${rel}`)}`,
    )
    for (const fn of route.fns) {
      const name = `__nifra_r${i}_${fn}`
      names.set(name, `${route.file}#${fn}`)
      lines.push(`declare const ${name}: __NifraReturned<typeof __nifra_m${i}, "${fn}">`)
    }
    for (const schema of route.schemas) {
      const name = `__nifra_d${i}_${schema}`
      names.set(name, `${route.file}#${schema}`)
      lines.push(`declare const ${name}: __NifraDeclared<typeof __nifra_m${i}, "${schema}">`)
    }
    route.holes?.forEach((hole, j) => {
      const name = `__nifra_h${i}_${j}`
      names.set(name, `${route.file}#boundaryLoaders.${hole}`)
      lines.push(
        `declare const ${name}: __NifraReturned<(typeof __nifra_m${i})["boundaryLoaders"][${JSON.stringify(hole)}], "load">`,
      )
    })
  })
  return { text: `${lines.join("\n")}\n`, names }
}

function legacyReader(
  ts: TypeScriptApi,
  checker: TSApi.TypeChecker,
  location: TSApi.Node,
): TypeReader<TSApi.Type> {
  const isReference = (type: TSApi.Type): type is TSApi.TypeReference => "target" in type
  return {
    flag: flagsFrom((name) => Reflect.get(ts.TypeFlags, name)),
    flags: (type) => type.flags,
    members: async (type) => (type.isUnionOrIntersection() ? type.types : []),
    symbolName: async (type) => type.getSymbol()?.name,
    aliasName: async (type) => type.aliasSymbol?.name,
    literal: async (type) => {
      if (type.isStringLiteral() || type.isNumberLiteral()) return type.value
      if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0)
        return checker.typeToString(type) === "true"
      return undefined
    },
    arrayElement: async (type) =>
      checker.isArrayType(type) && isReference(type)
        ? checker.getTypeArguments(type)[0]
        : undefined,
    tupleElements: async (type) =>
      checker.isTupleType(type) && isReference(type) ? checker.getTypeArguments(type) : undefined,
    typeArguments: async (type) => (isReference(type) ? checker.getTypeArguments(type) : []),
    properties: async (type) =>
      checker.getPropertiesOfType(type).map((property) => ({
        name: property.name,
        optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
        type: checker.getTypeOfSymbolAtLocation(property, location),
      })),
    stringIndex: async (type) =>
      checker
        .getIndexInfosOfType(type)
        .find((info) => (info.keyType.flags & ts.TypeFlags.StringLike) !== 0)?.type,
    callable: async (type) => checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0,
    text: async (type) => checker.typeToString(type),
  }
}

interface Symbol7 {
  readonly name: string
  readonly flags: number
}

interface Type7 {
  readonly flags: number
  readonly value?: unknown
  getSymbol(): Promise<Symbol7 | undefined>
  getAliasSymbol?(): Promise<Symbol7 | undefined>
  getTypes?(): Promise<readonly Type7[] | undefined>
}

interface Checker7 {
  getTypeAtPosition(file: string, position: number): Promise<Type7 | undefined>
  getTypeOfSymbol(symbol: Symbol7): Promise<Type7 | undefined>
  getPropertiesOfType(type: Type7): Promise<readonly Symbol7[]>
  getIndexInfosOfType(type: Type7): Promise<readonly { keyType: Type7; valueType: Type7 }[]>
  getSignaturesOfType(type: Type7, kind: number): Promise<readonly unknown[]>
  getTypeArguments(type: Type7): Promise<readonly Type7[]>
  typeToString(type: Type7): Promise<string>
  isTupleType(type: Type7): Promise<boolean>
  isArrayType(type: Type7): Promise<boolean>
}

const CHECKER7_METHODS = [
  "getTypeAtPosition",
  "getTypeOfSymbol",
  "getPropertiesOfType",
  "getIndexInfosOfType",
  "getSignaturesOfType",
  "getTypeArguments",
  "typeToString",
  "isTupleType",
  "isArrayType",
] as const

function isChecker7(value: unknown): value is Checker7 {
  return (
    typeof value === "object" &&
    value !== null &&
    CHECKER7_METHODS.every((method) => typeof Reflect.get(value, method) === "function")
  )
}

function reader7(semantic: TypeScriptSemanticSession, checker: Checker7): TypeReader<Type7> {
  const flag = flagsFrom((name) => semantic.typeFlags[name])
  const optional = semantic.symbolFlags.Optional
  const call = semantic.signatureKind.Call
  return {
    flag,
    flags: (type) => type.flags,
    members: async (type) => (await type.getTypes?.()) ?? [],
    symbolName: async (type) => (await type.getSymbol())?.name,
    aliasName: async (type) => (await type.getAliasSymbol?.())?.name,
    literal: async (type) => {
      if ((type.flags & flag.BooleanLiteral) !== 0)
        return (await checker.typeToString(type)) === "true"
      return typeof type.value === "string" || typeof type.value === "number"
        ? type.value
        : undefined
    },
    arrayElement: async (type) =>
      (await checker.isArrayType(type)) ? (await checker.getTypeArguments(type))[0] : undefined,
    tupleElements: async (type) =>
      (await checker.isTupleType(type)) ? checker.getTypeArguments(type) : undefined,
    typeArguments: async (type) => {
      try {
        return await checker.getTypeArguments(type)
      } catch {
        return []
      }
    },
    properties: async (type) => {
      const out: Property<Type7>[] = []
      for (const property of await checker.getPropertiesOfType(type)) {
        const propertyType = await checker.getTypeOfSymbol(property)
        if (propertyType === undefined) continue
        out.push({
          name: property.name,
          optional: typeof optional === "number" && (property.flags & optional) !== 0,
          type: propertyType,
        })
      }
      return out
    },
    stringIndex: async (type) =>
      (await checker.getIndexInfosOfType(type)).find(
        (info) => (info.keyType.flags & flag.StringLike) !== 0,
      )?.valueType,
    callable: async (type) =>
      typeof call === "number" && (await checker.getSignaturesOfType(type, call)).length > 0,
    text: (type) => checker.typeToString(type),
  }
}

/** Read every listed route function's return type and schema's output type through one program. */
async function readShapes(
  root: string,
  routes: readonly ProbeRoute[],
  sources: ReadonlyMap<string, string>,
): Promise<ProbeResult> {
  const warnings: string[] = []
  const shapes = new Map<string, Shape>()
  if (routes.length === 0) return { shapes, warnings }
  // TypeScript 7 resolves node handles only inside a configured project's root, so the probe and a
  // short-lived config extending the app's sit at the root, and are removed afterwards.
  const temp = await mkdtemp(join(root, ".nifra-schemas-"))
  const tempName = basename(temp)
  const probePath = join(root, `.${tempName}.ts`)
  const probeConfigPath = join(root, `.${tempName}.tsconfig.json`)
  const { text: probe, names } = probeSource(routes)
  const routeFiles = routes.map((route) => join(root, route.file))
  let close: (() => Promise<void>) | undefined
  try {
    await writeFile(probePath, probe, "utf8")
    const include = [...routes.map((route) => posix(route.file)), basename(probePath)]
    await writeFile(
      probeConfigPath,
      JSON.stringify(
        existsSync(join(root, "tsconfig.json"))
          ? {
              extends: "./tsconfig.json",
              compilerOptions: { allowImportingTsExtensions: true, noEmit: true },
              include,
            }
          : {
              compilerOptions: {
                module: "ESNext",
                moduleResolution: "Bundler",
                target: "ESNext",
                strict: true,
                allowImportingTsExtensions: true,
                noEmit: true,
                skipLibCheck: true,
              },
              include,
            },
      ),
      "utf8",
    )
    // The routes and every planned file the caller supplies are read from `sources`, not the disk:
    // a migration plans against the layout it has not written yet.
    const contents = new Map<string, string>([[probePath, probe]])
    for (const [file, text] of sources) contents.set(join(root, file), text)
    for (const file of routeFiles)
      if (!contents.has(file)) contents.set(file, readFileSync(file, "utf8"))
    const loaded = await loadProjectTypeScript(root, undefined, {
      files: [...contents.keys()],
      read: (file) => contents.get(file),
      projectConfig: probeConfigPath,
    })
    close = loaded.session?.close
    if (loaded.unsupported !== undefined) {
      warnings.push(`TypeScript ${loaded.unsupported.version} is outside the supported API`)
      return { shapes, warnings }
    }
    const ts = loaded.compiler
    if (ts === undefined) {
      warnings.push("TypeScript is not installed, so return types could not be read")
      return { shapes, warnings }
    }
    const semantic = loaded.session?.semantic
    if (semantic !== undefined) {
      const checker = (await semantic.getCheckerForFile(probePath)) ?? semantic.checker
      if (!isChecker7(checker)) {
        warnings.push("the TypeScript 7 checker lacks the calls this needs")
        return { shapes, warnings }
      }
      const reader = reader7(semantic, checker)
      for (const [name, key] of names) {
        const at = probe.indexOf(`declare const ${name}:`) + "declare const ".length
        const type = await checker.getTypeAtPosition(probePath, at)
        if (type !== undefined) shapes.set(key, await shapeOf(reader, type, new Set(), 0))
      }
      return { shapes, warnings }
    }
    const parsed = ts.getParsedCommandLineOfConfigFile(
      probeConfigPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {},
      },
    )
    const options: TSApi.CompilerOptions = {
      ...(parsed?.options ?? {}),
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
    }
    const program = ts.createProgram([probePath], options, overlaidHost(ts, options, contents))
    const source = program.getSourceFile(probePath)
    if (source === undefined) {
      warnings.push("could not create the type probe")
      return { shapes, warnings }
    }
    const checker = program.getTypeChecker()
    const reader = legacyReader(ts, checker, source)
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        const key = names.get(declaration.name.text)
        if (key === undefined) continue
        const type = checker.getTypeAtLocation(declaration.name)
        shapes.set(key, await shapeOf(reader, type, new Set(), 0))
      }
    }
    return { shapes, warnings }
  } finally {
    await close?.()
    await rm(probePath, { force: true })
    await rm(probeConfigPath, { force: true })
    await rm(temp, { recursive: true, force: true })
  }
}

/** A compiler host that reads `contents` (absolute path -> text) before the disk. */
function overlaidHost(
  ts: TypeScriptApi,
  options: TSApi.CompilerOptions,
  contents: ReadonlyMap<string, string>,
): TSApi.CompilerHost {
  const host = ts.createCompilerHost(options, true)
  const key = (file: string): string => posix(ts.sys.resolvePath(file))
  const overlay = new Map([...contents].map(([file, text]) => [key(file), text]))
  const folders = new Set<string>()
  for (const file of overlay.keys())
    for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1))
      folders.add(file.slice(0, at))
  const { fileExists, readFile, getSourceFile, directoryExists } = host
  return Object.assign(host, {
    fileExists: (file: string): boolean => overlay.has(key(file)) || fileExists.call(host, file),
    readFile: (file: string): string | undefined =>
      overlay.get(key(file)) ?? readFile.call(host, file),
    directoryExists: (folder: string): boolean =>
      folders.has(key(folder)) ||
      (directoryExists === undefined
        ? ts.sys.directoryExists(folder)
        : directoryExists.call(host, folder)),
    getSourceFile: (
      file: string,
      language: TSApi.ScriptTarget | TSApi.CreateSourceFileOptions,
      onError?: (message: string) => void,
      fresh?: boolean,
    ): TSApi.SourceFile | undefined => {
      const text = overlay.get(key(file))
      return text === undefined
        ? getSourceFile.call(host, file, language, onError, fresh)
        : ts.createSourceFile(file, text, language)
    },
  })
}

// ---- planning edits ----------------------------------------------------------------------------

export type OutputSchemaStatus =
  | "missing"
  | "generated"
  | "stale"
  | "regenerated"
  | "current"
  | "declared"
  | "no-data"
  | "unreadable"

export interface OutputSchemaEntry {
  readonly file: string
  readonly line: number
  readonly schema: OutputExport
  readonly status: OutputSchemaStatus
  /** The schema carries the `nifra:generated` marker. */
  readonly generated: boolean
  /** Returned paths the schema does not declare, so the output guard drops them. */
  readonly dropped: readonly string[]
  /** A generated schema whose text was changed under its marker: stale though its route is not. */
  readonly edited?: boolean
  readonly reason?: string
  /** Returned paths a draft leaves out: credential-like names, and values that are not JSON. */
  readonly omitted?: readonly string[]
  /** Returned paths a generated schema admits any value at, because the type there is `any` or
   * `unknown`: the output guard drops nothing below them until the type says what is sent. */
  readonly open?: readonly string[]
}

interface SchemaDeclaration {
  /** Start of the marker line when generated, else of the `export`. */
  readonly start: number
  readonly end: number
  /** The text the schema is declared with, after the `=`. */
  readonly value: string
  readonly line: number
  readonly hash: string | undefined
}

interface Target {
  readonly fn: RouteFn
  readonly schema: OutputExport
  /** Where a new declaration goes: above the function's export and its doc comment. */
  readonly insertAt: number
  readonly fnLine: number
  /** `export const loader: <type> = ...`: the checker reads that type, not what the body returns. */
  readonly annotated: boolean
  /** `undefined` when the schema is not exported; `null` when exported in a form not rewritten. */
  readonly declaration: SchemaDeclaration | null | undefined
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length
const lineStart = (text: string, index: number): number => text.lastIndexOf("\n", index - 1) + 1

/** The start of the comment block directly above the line at `start`, or `start`. */
function aboveComments(text: string, start: number): number {
  let at = start
  while (at > 0) {
    const previous = lineStart(text, at - 1)
    const line = text.slice(previous, at - 1).trim()
    if (!(line.startsWith("//") || line.startsWith("/*") || line.startsWith("*"))) break
    at = previous
  }
  return at
}

function declarationOf(
  content: string,
  mask: string,
  schema: OutputExport,
): SchemaDeclaration | null | undefined {
  const found = new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${schema}\\b[^=]*=`).exec(mask)
  if (found === null) return exported(mask, schema) === null ? undefined : null
  const valueStart = found.index + found[0].length
  let end = expressionEnd(mask, valueStart)
  if (content[end] === ";") end++
  const exportStart = lineStart(content, found.index)
  const markerStart = exportStart === 0 ? -1 : lineStart(content, exportStart - 1)
  const marker =
    markerStart === -1 ? null : MARKER.exec(content.slice(markerStart, exportStart - 1))
  return {
    start: marker === null ? found.index : markerStart,
    end,
    value: content.slice(valueStart, end),
    line: lineAt(content, found.index),
    hash: marker?.[1],
  }
}

function targetsOf(content: string): Target[] {
  const mask = codePositionMask(content)
  const targets: Target[] = []
  for (const [fn, schema] of PAIRS) {
    const found = exported(mask, fn)
    if (found === null) continue
    const reexport = found[0].startsWith("export {") || found[0].startsWith("export{")
    let after = found.index + found[0].length
    while (/\s/.test(mask[after] ?? "")) after++
    targets.push({
      fn,
      schema,
      insertAt: reexport ? content.length : aboveComments(content, lineStart(content, found.index)),
      fnLine: lineAt(content, found.index),
      annotated:
        !reexport &&
        /^(?:const|let|var)\b/.test(found[0].replace(/^export\s+/, "")) &&
        mask[after] === ":",
      declaration: declarationOf(content, mask, schema),
    })
  }
  return targets
}

const SCHEMA_IMPORT = /\bimport\s*(type\s*)?\{([^}]*)\}\s*from\s*["']@nifrajs\/schema["']/g
const IMPORT = /^import\b[\s\S]*?from\s*["'][^"'\n]+["'];?|^import\s*["'][^"'\n]+["'];?/gm
const T_BINDING =
  /\b(?:const|let|var|function|class)\s+t\b|\bimport\s+t\b|[{,]\s*t\s*[,}]|\bas\s+t\b/

/**
 * `content` with `t` imported from `@nifrajs/schema`, or `undefined` when `t` already names something
 * else in the file. Strings are blank in the code mask, so imports are read from the text and kept
 * only where the mask shows code.
 */
function withSchemaImport(content: string): string | undefined {
  const mask = codePositionMask(content)
  const inCode = (match: RegExpExecArray): boolean => mask[match.index] === "i"
  const imports = [...content.matchAll(SCHEMA_IMPORT)].filter(inCode)
  if (imports.some((m) => m[1] === undefined && /(?:^|,)\s*t\s*(?:,|$)/.test(m[2] ?? "")))
    return content
  if (T_BINDING.test(mask)) return undefined
  const named = imports.find((m) => m[1] === undefined)
  if (named !== undefined) {
    const brace = content.indexOf("{", named.index)
    return `${content.slice(0, brace + 1)} t,${content.slice(brace + 1)}`
  }
  let end = 0
  for (const match of content.matchAll(IMPORT))
    if (inCode(match)) end = match.index + match[0].length
  const line = 'import { t } from "@nifrajs/schema"'
  return end === 0
    ? `${line}\n\n${content}`
    : `${content.slice(0, end)}\n${line}${content.slice(end)}`
}

export interface OutputSchemaPlan {
  readonly entries: OutputSchemaEntry[]
  /** App-relative file -> its content with the planned schemas written. */
  readonly edits: Map<string, string>
  readonly warnings: readonly string[]
}

export interface OutputSchemaPlanOptions {
  /**
   * App-relative file -> text the types are read from instead of the disk: a layout planned but not
   * written yet. The routes' own text comes from `read`.
   */
  readonly overlay?: ReadonlyMap<string, string>
  /**
   * Only these declarations, and only where none exists: a draft for a missing schema, never a
   * refresh of a generated one or a change to a hand-written one.
   */
  readonly draft?: (file: string, schema: OutputExport) => boolean
}

/**
 * What each listed route backend half needs, and the file contents that would apply it. `nifra
 * schemas`, `nifra migrate layout` and the NF-C030 fix share it, so one return type drafts one schema.
 */
export async function planOutputSchemas(
  root: string,
  files: readonly string[],
  read: (file: string) => string | undefined,
  options: OutputSchemaPlanOptions = {},
): Promise<OutputSchemaPlan> {
  const { draft } = options
  const perFile = new Map<string, { content: string; targets: Target[] }>()
  for (const file of files) {
    const content = read(file)
    if (content === undefined) continue
    const targets = targetsOf(content)
    if (targets.length > 0) perFile.set(file, { content, targets })
  }
  const chosen = (file: string, target: Target): boolean =>
    draft === undefined || (draft(file, target.schema) && target.declaration === undefined)
  const probe: ProbeRoute[] = [...perFile].flatMap(([file, { targets }]) => {
    const read = targets.filter((target) => chosen(file, target))
    return read.length === 0
      ? []
      : [
          {
            file,
            fns: read.map((target) => target.fn),
            schemas: read.filter((t) => t.declaration !== undefined).map((t) => t.schema),
          },
        ]
  })
  const sources = new Map(options.overlay)
  for (const [file, { content }] of perFile) sources.set(file, content)
  const { shapes, warnings } = await readShapes(root, probe, sources)
  const entries: OutputSchemaEntry[] = []
  const edits = new Map<string, string>()
  if (warnings.length > 0) return { entries, edits, warnings }
  for (const [file, { content, targets }] of perFile) {
    const mask = codePositionMask(content)
    const replacements: Array<{ start: number; end: number; text: string; entry: number }> = []
    for (const target of targets) {
      if (!chosen(file, target)) continue
      const raw = shapes.get(`${file}#${target.fn}`)
      const declared = shapes.get(`${file}#${target.schema}`)
      const { declaration } = target
      const line = declaration?.line ?? target.fnLine
      const entry = (
        status: OutputSchemaStatus,
        dropped: readonly string[] = [],
        reason?: string,
        edited = false,
        omitted: readonly string[] = [],
        open: readonly string[] = [],
      ): number => {
        const schema = target.schema
        const generated = declaration?.hash !== undefined
        const base: OutputSchemaEntry = { file, line, schema, status, generated, dropped }
        const item: OutputSchemaEntry =
          reason !== undefined ? { ...base, reason } : edited ? { ...base, edited } : base
        const withOmitted = omitted.length === 0 ? item : { ...item, omitted }
        return entries.push(open.length === 0 ? withOmitted : { ...withOmitted, open }) - 1
      }
      if (target.annotated) {
        // A `Route.Loader` annotation returns the schema's own input type: comparing the two would
        // always agree, so the schema is reported unchecked rather than passed.
        entry(
          "unreadable",
          [],
          `${target.fn} has a type annotation, so its return type is the annotation's, not what it returns. Remove the annotation to have the schema generated and checked, or delete the "nifra:generated" line to own the schema by hand`,
        )
        continue
      }
      if (raw === undefined) {
        entry("unreadable", [], "TypeScript could not read its type")
        continue
      }
      const returned = dataShape(raw)
      if (returned.kind === "never") {
        entry("no-data")
        continue
      }
      const dropped =
        declared === undefined || declared.kind === "never"
          ? []
          : undeclaredPaths(returned, declared)
      if (declaration === null || (declaration !== undefined && declaration.hash === undefined)) {
        entry("declared", dropped)
        continue
      }
      if (returned.kind === "json" && returned.reason !== undefined) {
        entry(
          "unreadable",
          dropped,
          `the ${target.fn}'s return type is ${returned.reason}: annotate it, or write the schema by hand`,
        )
        continue
      }
      const body = schemaSource(returned)
      const omitted = omittedPaths(returned)
      const open = openPaths(returned)
      if (declaration === undefined) {
        // The name bound any other way (declared, imported) would clash with the one written here.
        if (new RegExp(`(?<![\\w$.])${target.schema}(?![\\w$])`).test(mask)) {
          entry(
            "missing",
            [],
            `\`${target.schema}\` already names something in this file, so no draft was written`,
          )
          continue
        }
        const at = entry("missing", [], undefined, false, omitted, open)
        const written = declarationText(target.schema, target.fn, body)
        const text = target.insertAt === content.length ? `\n${written}\n` : `${written}\n\n`
        replacements.push({ start: target.insertAt, end: target.insertAt, text, entry: at })
      } else if (
        declaration.hash === hashOf(body) &&
        schemaTokens(declaration.value) === schemaTokens(body)
      ) {
        entry("current", [], undefined, false, [], open)
      } else {
        // The marker still matches what would be written, so the text under it was edited.
        const edited = declaration.hash === hashOf(body)
        const at = entry("stale", dropped, undefined, edited, omitted, open)
        const text = declarationText(target.schema, target.fn, body)
        replacements.push({ start: declaration.start, end: declaration.end, text, entry: at })
      }
    }
    if (replacements.length === 0) continue
    let next = content
    for (const r of replacements.sort((a, b) => b.start - a.start))
      next = `${next.slice(0, r.start)}${r.text}${next.slice(r.end)}`
    const imported = withSchemaImport(next)
    if (imported === undefined) {
      for (const r of replacements) {
        const blocked = entries[r.entry]
        if (blocked !== undefined)
          entries[r.entry] = {
            ...blocked,
            reason: "`t` already names something else in this file, so it was left as is",
          }
      }
      continue
    }
    edits.set(file, imported)
  }
  entries.sort((a, b) => codeUnitOrder(a.file, b.file) || a.line - b.line)
  return { entries, edits, warnings }
}

/**
 * What hole `hole`'s loader in the backend half `file` returns, with `text` read as that file: the
 * data a fix that writes the loader drafts its output schema from.
 */
export async function holeLoaderShape(
  root: string,
  file: string,
  hole: string,
  text: string,
): Promise<{ readonly shape?: Shape; readonly warnings: readonly string[] }> {
  const { shapes, warnings } = await readShapes(
    root,
    [{ file, fns: [], schemas: [], holes: [hole] }],
    new Map([[file, text]]),
  )
  const shape = shapes.get(`${file}#boundaryLoaders.${hole}`)
  return shape === undefined ? { warnings } : { shape: dataShape(shape), warnings }
}

// ---- entry points ------------------------------------------------------------------------------

const ROUTE_BACKEND_TS = /\.backend\.[cm]?ts$/

function routeBackends(dir: string): string[] {
  const routes = join(dir, "routes")
  if (!existsSync(routes)) return []
  return readdirSync(routes, { recursive: true, encoding: "utf8" })
    .map((file) => posix(join("routes", file)))
    .filter((file) => ROUTE_BACKEND_TS.test(file) && !file.split("/").includes("node_modules"))
    .sort(codeUnitOrder)
}

export interface OutputSchemasReport {
  readonly ok: boolean
  readonly write: boolean
  readonly entries: readonly OutputSchemaEntry[]
  readonly written: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * Every route backend half under `<dir>/routes`: report what each loader's and action's schema needs,
 * and with `write`, write the missing schemas and refresh the stale generated ones. A hand-written
 * schema is never touched; its entry lists the returned fields it drops.
 */
export async function outputSchemas(
  dir: string,
  options: { readonly write?: boolean; readonly check?: boolean } = {},
): Promise<OutputSchemasReport> {
  const write = options.write === true
  const { entries, edits, warnings } = await planOutputSchemas(dir, routeBackends(dir), (file) => {
    try {
      return readFileSync(join(dir, file), "utf8")
    } catch {
      return undefined
    }
  })
  const written: string[] = []
  let final = entries
  if (write) {
    for (const [file, content] of edits) {
      writeFileSync(join(dir, file), content)
      written.push(file)
    }
    final = entries.map((entry) =>
      !written.includes(entry.file) || entry.reason !== undefined
        ? entry
        : entry.status === "missing"
          ? { ...entry, status: "generated" }
          : entry.status === "stale"
            ? { ...entry, status: "regenerated" }
            : entry,
    )
  }
  // `check` also fails what a review still owes: a schema not written yet, and one that admits anything.
  const owed = (entry: OutputSchemaEntry): boolean =>
    entry.status === "missing" || (entry.open?.length ?? 0) > 0
  return {
    ok:
      warnings.length === 0 &&
      !final.some((entry) => entry.status === "stale" || (options.check === true && owed(entry))),
    write,
    entries: final,
    written,
    warnings,
  }
}

/**
 * The generated schemas among `files` whose route now returns a different shape (NF-C033), and those
 * it could not compare. `warnings` says why nothing could be read at all.
 */
export async function staleGeneratedSchemas(
  root: string,
  files: readonly string[],
  read: (file: string) => string | undefined,
): Promise<{
  readonly stale: readonly OutputSchemaEntry[]
  readonly unchecked: readonly OutputSchemaEntry[]
  readonly warnings: readonly string[]
}> {
  const marked = files.filter((file) => read(file)?.includes(GENERATED_MARK) === true)
  if (marked.length === 0) return { stale: [], unchecked: [], warnings: [] }
  const { entries, warnings } = await planOutputSchemas(root, marked, read)
  return {
    stale: entries.filter((entry) => entry.status === "stale"),
    unchecked: entries.filter((entry) => entry.generated && entry.status === "unreadable"),
    warnings,
  }
}

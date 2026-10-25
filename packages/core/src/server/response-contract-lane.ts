/**
 * Making a route's declared `response` schema mean something at runtime.
 *
 * ## The gap this closes
 *
 * A `response` schema is a LOWER bound, not an upper one. It says "at least these fields, of these
 * types"; it never said "only these". TypeScript does not close the gap either - excess-property
 * checking fires on a fresh object literal in an annotated position, and a handler is neither: it is a
 * contextually-typed argument that usually returns a variable. So this compiles, and ships every field:
 *
 *     app.get("/me", { response: PublicUser }, async () => {
 *       const user = await db.users.find(id)   // { id, name, email, passwordHash, ... }
 *       return user                            // all of it goes on the wire
 *     })
 *
 * The client's type says `{ id, name }`, so the leak is invisible from both ends. And it can appear
 * with no code change at all: add a column to `users`, and the next deploy ships it to browsers.
 *
 * ## Why the behaviour follows the schema, not this module
 *
 * Standard Schema exposes exactly one operation - `validate` - and no way to enumerate a schema's
 * declared keys. So a projection of "just the declared fields" cannot be written generically here;
 * the only clean value available is whatever `validate()` returns. That is deliberate on the spec's
 * part, and it means enforcement inherits each validator's own semantics:
 *
 *   - a STRIPPING schema (zod, valibot) returns a cleaned value -> the undeclared fields are removed
 *   - a STRICT schema (`@nifrajs/schema`'s `t.object`) reports issues -> the response is a violation
 *
 * That is not an inconsistency to paper over: a strict schema has already declared that extra fields
 * are an error, and a stripping one has declared they are ignorable. Enforcement honours what the
 * author wrote rather than overriding it - unless the app asks for `extra: "strip"`. A schema that
 * carries its JSON Schema as `jsonSchema` (every `t` schema does) CAN list its declared keys, so for
 * those the payload is projected onto the declared shape before it is validated.
 *
 * ## What is judged is what is written
 *
 * `JSON.stringify` writes what a `toJSON` hook returns, not the fields a validator reads off the
 * object. So a value's hooks are applied first, as the serializer would, and that result is validated
 * and sent: a class whose `toJSON` adds a private field fails a closed schema instead of passing on its
 * public ones. `strip` keeps the declared fields of what the hook writes, so a hook that writes `id`
 * from private state keeps it. A `Date` is judged as the ISO string its own hook writes, so a
 * `t.string({ format: "date-time" })` field holding a database timestamp passes; only where the schema
 * declares `t.date()` does it stay a `Date`. A schema without `jsonSchema` (zod, valibot) cannot say
 * where that is, so it is shown every `Date` as one.
 *
 * ## What enforcement costs
 *
 * Less than it looks like it should. With a compiled validator (`@nifrajs/schema`'s `t` compiles at
 * construction; zod/valibot equivalents are similarly cheap), the check itself measures in the
 * ~100ns-per-response range - on a realistic middleware-carrying route, enforce mode benchmarks
 * within measurement noise of the same route with no contract at all, on Bun and Node alike. Looking
 * for `toJSON` hooks visits every object in the payload, about 13 ns each, so a 50-row list pays near
 * 0.7 us. The other cost is structural: a contracted route cannot take the bare-route fused lane, because
 * the check needs the handler's VALUE before it becomes bytes. A route with any middleware, derive,
 * or lifecycle hook has already left that lane, so for the routes that look like production the
 * contract is effectively free - declare it.
 */
import {
  formatStandardIssues,
  type StandardResult,
  type StandardSchemaV1,
} from "../schema/standard.ts"
import { INSTALL_RESPONSE_CONTRACT } from "./install.ts"
import { jsonText } from "./json-text.ts"
import type { IdentityPlugin } from "./plugin.ts"
import { isResponseResult, status } from "./runtime-core.ts"
import type { AnyServer } from "./server.ts"

/**
 * How hard a declared `response` schema is held.
 *
 *   - `warn`    - check and log; the response is sent UNCHANGED, so enabling it cannot break anything.
 *   - `enforce` - serialize the validated value, so undeclared data cannot reach the wire.
 *
 * There is no `off`: not installing the plugin IS off, and that is what keeps this module out of an
 * app's bundle entirely rather than shipping a disabled branch to everyone.
 */
export type ResponseContractMode = "warn" | "enforce"

export interface ResponseContractOptions {
  /**
   * Fields the schema does not declare. `"reject"` (the default) leaves them to the validator: a
   * closed `t.object` reports them, so an enforced response becomes a 500 and the log names them.
   * `"strip"` drops them first, for any schema exposing its JSON Schema as `jsonSchema` (every
   * `@nifrajs/schema` `t` schema) - nested objects, arrays and records included. A union is projected
   * when an object value can meet only one of its branches: a single object branch, or object
   * branches that all require one key holding literals no two branches share (`ok: true` /
   * `ok: false`, `kind: "a"` / `kind: "b"`). Schemas without `jsonSchema` (zod, valibot) are
   * unaffected: they already strip or reject by their own rules.
   */
  readonly extra?: "reject" | "strip"
  /**
   * `enforce` only: log the names of the fields that never reached the wire - dropped by `extra:
   * "strip"` or by a validator that strips on its own - so a field the contract does not declare
   * (a new column) shows up in the log instead of vanishing. Logged as a `warn` named "response
   * contract", once per route for each distinct set of names, at most 32 sets per route. Values are
   * never logged. Each response is compared with what was sent, so it costs a walk of the payload.
   */
  readonly logStripped?: boolean
  /**
   * Called for every response the contract has something to say about, for a metric or an alert, where
   * the log speaks once per route. `violation`: enforce mode, the payload failed and a 500 went out in
   * its place. `warn`: warn mode, the payload failed or carried undeclared top-level keys (`fields`)
   * and was sent anyway. `stripped`: enforce mode, the payload was sent without `fields`. The message is
   * the text the log line carries; values are never passed. Called before the response is sent; a hook
   * that throws, rejects or is not a function is logged once and changes nothing. In enforce mode it costs the payload walk
   * `logStripped` does.
   */
  readonly onReport?: (report: ResponseContractReport) => void
}

/** One response the contract reported on, passed to {@link ResponseContractOptions.onReport}. */
export interface ResponseContractReport {
  readonly kind: "violation" | "warn" | "stripped"
  /** The route's method as registered, e.g. `GET`. */
  readonly method: string
  /** The route's path as registered, e.g. `/users/:id`, so a metric keyed by it stays bounded. */
  readonly route: string
  /** `stripped`: each field that never reached the wire (`user.passwordHash`, `items[].cost`), sorted.
   * `warn`: the undeclared top-level keys that were sent, when they are the reason. */
  readonly fields?: readonly string[] | undefined
  readonly message: string
}

/** Success and status-specific error schemas captured by one route at registration time. */
export interface ResponseContractDefinition {
  readonly response?: StandardSchemaV1
  readonly errors?: Readonly<Record<number, StandardSchemaV1>>
}

/** The outcome of checking one handler result against its declared response schema. */
export type ResponseContractOutcome =
  /** Nothing to report. `value` is what should be serialized (the original result, or the cleaned one). */
  | { readonly kind: "ok"; readonly value: unknown }
  /** Logged, then `value` is served: in `warn` the ORIGINAL result, in `enforce` (with
   * `logStripped`) the cleaned one. `fields`: in `warn`, the undeclared keys when they are the reason. */
  | {
      readonly kind: "warn"
      readonly value: unknown
      readonly message: string
      readonly fields?: readonly string[]
    }
  /** `enforce` only: the payload cannot be reconciled with the contract, so it must not be sent. */
  | { readonly kind: "violation"; readonly message: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Rebuilds a value with only what its schema declares; absent when the schema can strip nothing. */
type Projector = (value: unknown) => unknown

const projectors = new WeakMap<object, Projector | null>()

/** The projector for a schema's JSON Schema, compiled once per schema. `dates` is
 * {@link writesDates} of `node`. */
function projectorOf(node: object, dates: boolean): Projector | undefined {
  let found = projectors.get(node)
  if (found === undefined) {
    found = compileProjector(node, dates) ?? null
    projectors.set(node, found)
  }
  return found ?? undefined
}

/** The JSON Schema a schema carries as `jsonSchema` (every `@nifrajs/schema` `t` schema), if any. */
function jsonSchemaOf(schema: StandardSchemaV1): object | undefined {
  const node: unknown = Reflect.get(schema, "jsonSchema")
  return typeof node === "object" && node !== null ? node : undefined
}

const objectField = (node: object, key: string): object | undefined => {
  const value: unknown = Reflect.get(node, key)
  return typeof value === "object" && value !== null ? value : undefined
}

function compileProjector(node: unknown, dates: boolean): Projector | undefined {
  if (typeof node !== "object" || node === null) return undefined
  const schema: object = node
  const type: unknown = Reflect.get(schema, "type")
  const branches: unknown = Reflect.get(schema, "anyOf") ?? Reflect.get(schema, "oneOf")
  if (Array.isArray(branches)) return compileUnion(branches, dates)
  if (type === "array") {
    const items: unknown = Reflect.get(schema, "items")
    const item = Array.isArray(items) ? undefined : compileProjector(items, dates)
    return item === undefined
      ? undefined
      : (value) => {
          if (!Array.isArray(value)) return value
          const out: unknown[] = []
          for (let i = 0; i < value.length; i++) out.push(item(writtenAt(value[i], i, dates)))
          return out
        }
  }
  if (type !== "object") return undefined
  const properties = objectField(schema, "properties") ?? {}
  const keys = Object.keys(properties)
  const nested = new Map<string, Projector>()
  for (const key of keys) {
    const projector = compileProjector(Reflect.get(properties, key), dates)
    if (projector !== undefined) nested.set(key, projector)
  }
  const patterns: Array<readonly [RegExp, Projector | undefined]> = []
  for (const [source, child] of Object.entries(objectField(schema, "patternProperties") ?? {})) {
    let pattern: RegExp
    try {
      pattern = new RegExp(source, "u")
    } catch {
      return undefined // a pattern this engine can't read: the validator judges the value whole
    }
    patterns.push([pattern, compileProjector(child, dates)])
  }
  const closed = Reflect.get(schema, "additionalProperties") === false
  if (!closed && nested.size === 0 && patterns.every(([, projector]) => projector === undefined))
    return undefined
  const declared = new Set(keys)
  return (value) => {
    if (!isPlainObject(value)) return value
    const out: Record<string, unknown> = closed ? {} : { ...value }
    for (const key of closed ? keys : nested.keys()) {
      if (!hasField(value, key)) continue
      const projector = nested.get(key)
      define(
        out,
        key,
        projector === undefined ? value[key] : projector(writtenAt(value[key], key, dates)),
      )
    }
    if (patterns.length > 0) projectPatternKeys(value, out, declared, patterns, closed, dates)
    return out
  }
}

/** A getter on a row class's prototype is a declared field; `Object.prototype`'s members are not. */
const hasField = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key) || (key in value && !(key in Object.prototype))

/**
 * A union projects a value onto the one branch able to accept it, and leaves anything less certain to
 * the validator. JSON Schema's `object` never matches an array nor `array` an object, so the two are
 * routed apart; two object branches are told apart only by a discriminator (see
 * {@link compileDiscriminated}). A branch that could hold anything (`{}`, `$ref`, `allOf`) stops it.
 */
function compileUnion(branches: readonly unknown[], dates: boolean): Projector | undefined {
  const objects: object[] = []
  const arrays: object[] = []
  if (!sortBranches(branches, objects, arrays)) return undefined
  const forArray = arrays.length === 1 ? compileProjector(arrays[0], dates) : undefined
  const forObject =
    objects.length === 1
      ? compileProjector(objects[0], dates)
      : objects.length > 1
        ? compileDiscriminated(objects, dates)
        : undefined
  if (forArray === undefined && forObject === undefined) return undefined
  return (value) => {
    if (Array.isArray(value)) return forArray === undefined ? value : forArray(value)
    return forObject !== undefined && isPlainObject(value) ? forObject(value) : value
  }
}

/** Sort a union's branches, nested unions flattened; `false` when one could hold anything. */
function sortBranches(branches: readonly unknown[], objects: object[], arrays: object[]): boolean {
  for (const branch of branches) {
    if (branch === false) continue
    if (typeof branch !== "object" || branch === null) return false
    const nested: unknown = Reflect.get(branch, "anyOf") ?? Reflect.get(branch, "oneOf")
    if (Array.isArray(nested)) {
      if (!sortBranches(nested, objects, arrays)) return false
      continue
    }
    const type: unknown = Reflect.get(branch, "type")
    if (type === "object") objects.push(branch)
    else if (type === "array") arrays.push(branch)
    else if (typeof type === "string") continue
    else if (type !== undefined || literalsOf(branch) === undefined) return false
  }
  return true
}

/**
 * Object branches that all require one key, each holding literals no other branch holds: at most one
 * branch can accept a value, so projecting onto the branch its tag names cannot strip a field another
 * branch needed. The first such key in the first branch's declared order is used. A value whose tag
 * names no branch is left to the validator, which rejects it.
 */
function compileDiscriminated(branches: readonly object[], dates: boolean): Projector | undefined {
  const projectors = branches.map((branch) => compileProjector(branch, dates))
  const first = branches[0]
  if (first === undefined || projectors.every((projector) => projector === undefined))
    return undefined
  for (const key of Object.keys(objectField(first, "properties") ?? {})) {
    const byTag = new Map<unknown, Projector | undefined>()
    const disjoint = branches.every((branch, index) => {
      const tags = requiredLiterals(branch, key)
      if (tags === undefined) return false
      for (const tag of tags) {
        if (byTag.has(tag)) return false
        byTag.set(tag, projectors[index])
      }
      return true
    })
    if (!disjoint) continue
    return (value) => {
      if (!isPlainObject(value) || !hasField(value, key)) return value
      const projector = byTag.get(value[key])
      return projector === undefined ? value : projector(value)
    }
  }
  return undefined
}

/** The distinct literals `key` may hold in an object branch that requires it. */
function requiredLiterals(branch: object, key: string): ReadonlySet<unknown> | undefined {
  const required: unknown = Reflect.get(branch, "required")
  const properties = objectField(branch, "properties")
  if (!Array.isArray(required) || !required.includes(key)) return undefined
  if (properties === undefined || !Object.hasOwn(properties, key)) return undefined
  const literals = literalsOf(Reflect.get(properties, key))
  return literals === undefined ? undefined : new Set(literals)
}

const isLiteral = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value)

/** The finite set of primitives a schema admits (`const`, `enum`, `null`, a union of those), else `undefined`. */
function literalsOf(node: unknown): readonly unknown[] | undefined {
  if (typeof node !== "object" || node === null) return undefined
  if (Object.hasOwn(node, "const")) {
    const value: unknown = Reflect.get(node, "const")
    return isLiteral(value) ? [value] : undefined
  }
  const listed: unknown = Reflect.get(node, "enum")
  if (Array.isArray(listed))
    return listed.length > 0 && listed.every(isLiteral) ? listed : undefined
  const branches: unknown = Reflect.get(node, "anyOf") ?? Reflect.get(node, "oneOf")
  if (Array.isArray(branches)) {
    const all: unknown[] = []
    for (const branch of branches) {
      const literals = literalsOf(branch)
      if (literals === undefined) return undefined
      all.push(...literals)
    }
    return all.length > 0 ? all : undefined
  }
  return Reflect.get(node, "type") === "null" ? [null] : undefined
}

/**
 * Carry the undeclared keys a `patternProperties` entry admits: a closed record's keys are all
 * pattern keys, so dropping them empties a valid value. A key two patterns match is copied verbatim,
 * since projecting it onto one could strip what the other requires.
 */
function projectPatternKeys(
  value: Record<string, unknown>,
  out: Record<string, unknown>,
  declared: ReadonlySet<string>,
  patterns: ReadonlyArray<readonly [RegExp, Projector | undefined]>,
  closed: boolean,
  dates: boolean,
): void {
  for (const key of Object.keys(value)) {
    if (declared.has(key)) continue
    let projector: Projector | undefined
    let matches = 0
    for (const [pattern, child] of patterns)
      if (pattern.test(key)) {
        projector = child
        matches++
      }
    if (matches === 0) continue
    if (matches === 1 && projector !== undefined)
      define(out, key, projector(writtenAt(value[key], key, dates)))
    else if (closed) define(out, key, value[key])
  }
}

/** `__proto__` is a declared name like any other here; plain assignment would set the prototype. */
function define(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__")
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  else out[key] = value
}

const DATE_TO_JSON = Date.prototype.toJSON
/** The JSON Schema key `t.date()` sets. */
const DATE_KEY = "x-nifra-date"

// Deeper than this, the copying walk takes over with its own cycle check.
const MAX_HOOK_SCAN_DEPTH = 64

/** What {@link hooksIn} finds: only `Date`s' own hooks, or any other. */
const DATE_HOOK = 1
const OTHER_HOOK = 2

const isDate = (value: object, hook: unknown): boolean =>
  hook === DATE_TO_JSON && value instanceof Date

/**
 * The `toJSON` hooks `value` holds: {@link OTHER_HOOK} for any but a `Date`'s own, else
 * {@link DATE_HOOK} for a `Date` when `dates` writes them, else 0. Allocates nothing: most payloads
 * have none, and this is the price every contracted response pays.
 */
function hooksIn(value: object, depth: number, dates: boolean): number {
  if (depth > MAX_HOOK_SCAN_DEPTH) return OTHER_HOOK
  const hook: unknown = Reflect.get(value, "toJSON")
  if (typeof hook === "function") return isDate(value, hook) ? (dates ? DATE_HOOK : 0) : OTHER_HOOK
  let found = 0
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i]
      if (typeof item !== "object" || item === null) continue
      const inner = hooksIn(item, depth + 1, dates)
      if (inner === OTHER_HOOK) return inner
      if (inner !== 0) found = inner
    }
    return found
  }
  // Inherited enumerable keys are scanned too; that only ever sends a value to the copying walk.
  for (const key in value) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `key` was enumerated from `value`; `Reflect.get` here halves the speed of this for-in.
    const field: unknown = (value as Record<string, unknown>)[key]
    if (typeof field !== "object" || field === null) continue
    const inner = hooksIn(field, depth + 1, dates)
    if (inner === OTHER_HOOK) return inner
    if (inner !== 0) found = inner
  }
  return found
}

const hooksOf = (value: unknown, dates: boolean): number =>
  typeof value === "object" && value !== null ? hooksIn(value, 0, dates) : 0

/**
 * What `JSON.stringify` writes for `value`: every `toJSON` hook applied as the serializer applies it,
 * so the contract judges the bytes that go out rather than fields a hook then replaces. Copies only the
 * containers above a hook. A `Date` keeps its object unless `dates`.
 */
const wireValueOf = (value: unknown, dates: boolean): unknown =>
  hooksOf(value, dates) === 0 ? value : wireValue(value, "", [], dates)

const wireValue = (value: unknown, key: string | number, path: object[], dates: boolean): unknown =>
  wireChildren(writtenAt(value, key, dates), path, dates)

/** `value` as the serializer takes it under `key`: its own hook applied, its fields still as they are. */
function writtenAt(value: unknown, key: string | number, dates: boolean): unknown {
  if (typeof value !== "object" || value === null) return value
  const hook: unknown = Reflect.get(value, "toJSON")
  if (typeof hook !== "function" || (!dates && isDate(value, hook))) return value
  return fieldsOf(Reflect.apply(hook, value, [String(key)]))
}

/**
 * The serializer calls one hook per value, so a hook's result that has a hook of its own is written
 * by its fields. Copying them out keeps that second hook from running when the checked value is sent.
 */
function fieldsOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value
  if (typeof Reflect.get(value, "toJSON") !== "function") return value
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, i): unknown => value[i])
  const fields: Record<string, unknown> = {}
  for (const name of Object.keys(value))
    if (name !== "toJSON") define(fields, name, Reflect.get(value, name))
  return fields
}

function wireChildren(value: unknown, path: object[], dates: boolean): unknown {
  // A cycle is left as it is for `JSON.stringify` to refuse.
  if (typeof value !== "object" || value === null || path.includes(value)) return value
  path.push(value)
  if (Array.isArray(value)) {
    let items: unknown[] | undefined
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i]
      const written = wireValue(item, i, path, dates)
      if (written !== item) items ??= value.slice(0, i)
      if (items !== undefined) items[i] = written
    }
    path.pop()
    return items ?? value
  }
  const keys = Object.keys(value)
  let out: Record<string, unknown> | undefined
  let index = 0
  for (const name of keys) {
    const field: unknown = Reflect.get(value, name)
    const written = wireValue(field, name, path, dates)
    if (written !== field && out === undefined) {
      out = {}
      for (const earlier of keys.slice(0, index)) define(out, earlier, Reflect.get(value, earlier))
    }
    if (out !== undefined) define(out, name, written)
    index++
  }
  path.pop()
  return out ?? value
}

const dateSchemas = new WeakMap<object, boolean>()

/** Whether a JSON Schema node has room for a `Date` as such: it or a node in it is a `t.date()`, or
 * a `$ref` this cannot follow. */
function holdsDate(node: object): boolean {
  let found = dateSchemas.get(node)
  if (found === undefined) {
    found = declaresDate(node, 0)
    dateSchemas.set(node, found)
  }
  return found
}

function declaresDate(node: unknown, depth: number): boolean {
  if (typeof node !== "object" || node === null) return false
  if (depth > MAX_HOOK_SCAN_DEPTH || keepsDate(node)) return true
  for (const child of Object.values(node)) if (declaresDate(child, depth + 1)) return true
  return false
}

const isRef = (node: object): boolean => Object.hasOwn(node, "$ref")
const keepsDate = (node: object): boolean => Reflect.get(node, DATE_KEY) === true || isRef(node)

/** Whether every `Date` under `node` is judged as what its hook writes: it holds no `t.date()`. */
const writesDates = (node: object): boolean => !holdsDate(node)

/** Push `node` and its `anyOf` / `oneOf` / `allOf` branches, nested ones flattened, onto `out`. */
function branchesOf(node: unknown, out: object[]): object[] {
  if (typeof node !== "object" || node === null) return out
  out.push(node)
  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    const branches: unknown = Reflect.get(node, combinator)
    if (Array.isArray(branches)) for (const branch of branches) branchesOf(branch, out)
  }
  return out
}

/** The nodes that describe field `key` of an object described by `nodes`. */
function fieldNodes(nodes: readonly object[], key: string): object[] {
  const out: object[] = []
  for (const node of nodes) {
    const properties = objectField(node, "properties")
    let matched = properties !== undefined && Object.hasOwn(properties, key)
    if (matched && properties !== undefined) branchesOf(Reflect.get(properties, key), out)
    for (const [source, child] of Object.entries(objectField(node, "patternProperties") ?? {}))
      if (patternMatches(source, key)) {
        branchesOf(child, out)
        matched = true
      }
    if (!matched) branchesOf(Reflect.get(node, "additionalProperties"), out)
  }
  return out
}

/** The nodes that describe item `index` of an array described by `nodes`. */
function itemNodes(nodes: readonly object[], index: number): object[] {
  const out: object[] = []
  for (const node of nodes) {
    const items: unknown = Reflect.get(node, "items")
    const prefix: unknown = Reflect.get(node, "prefixItems")
    const tuple = Array.isArray(prefix) ? prefix : Array.isArray(items) ? items : undefined
    if (tuple === undefined) branchesOf(items, out)
    else if (index < tuple.length) branchesOf(tuple[index], out)
    else branchesOf(tuple === prefix ? items : Reflect.get(node, "additionalItems"), out)
  }
  return out
}

const tupleLength = (node: object): number => {
  const tuple: unknown = Reflect.get(node, "prefixItems") ?? Reflect.get(node, "items")
  return Array.isArray(tuple) ? tuple.length : 0
}

const keyPatterns = new Map<string, RegExp | null>()

/** A pattern this engine can't read is taken to match, so its node stays in view. */
function patternMatches(source: string, key: string): boolean {
  let pattern = keyPatterns.get(source)
  if (pattern === undefined) {
    try {
      pattern = new RegExp(source, "u")
    } catch {
      pattern = null
    }
    keyPatterns.set(source, pattern)
  }
  return pattern === null || pattern.test(key)
}

/**
 * `value` with each `Date` judged as what its hook writes, but where the schema node at its place is
 * a `t.date()`. Compiled once per schema, since the `t.date()` route it serves sends many of them.
 */
type DateWriter = (value: unknown) => unknown

const KEEP_ALL: DateWriter = (value) => value
const WRITE_ALL: DateWriter = (value) => wireValueOf(value, true)

const dateWriters = new WeakMap<object, DateWriter>()

function dateWriterOf(node: object): DateWriter {
  let found = dateWriters.get(node)
  if (found === undefined) {
    found = compileDates(branchesOf(node, []), 0)
    dateWriters.set(node, found)
  }
  return found
}

/**
 * The writer for a place `nodes` (union branches flattened) describe. Below a `$ref`, which this does
 * not follow, a `Date` stays one. An undeclared field is written only where `patternProperties` or an
 * `additionalProperties` schema describes it: elsewhere the schema refuses it or takes anything.
 */
function compileDates(nodes: readonly object[], depth: number): DateWriter {
  if (!nodes.some(holdsDate)) return WRITE_ALL
  if (depth > MAX_HOOK_SCAN_DEPTH || nodes.some(isRef)) return KEEP_ALL
  const keep = nodes.some(keepsDate)
  const declared = new Set<string>()
  for (const node of nodes)
    for (const key of Object.keys(objectField(node, "properties") ?? {})) declared.add(key)
  const described = nodes.some(
    (node) =>
      objectField(node, "patternProperties") !== undefined ||
      objectField(node, "additionalProperties") !== undefined,
  )
  const fields: DateFields = {
    declared,
    writers: [...declared].map((key) => [key, compileDates(fieldNodes(nodes, key), depth + 1)]),
    undeclared: described ? undeclaredWriters(nodes, depth + 1) : undefined,
  }
  // The last writer is for every item past the longest tuple.
  const items = Array.from({ length: Math.max(0, ...nodes.map(tupleLength)) + 1 }, (_, i) =>
    compileDates(itemNodes(nodes, i), depth + 1),
  )
  return (value) => {
    if (typeof value !== "object" || value === null) return value
    if (isDate(value, Reflect.get(value, "toJSON")))
      return keep ? value : Reflect.apply(DATE_TO_JSON, value, [])
    return Array.isArray(value) ? writeItems(value, items) : writeFields(value, fields)
  }
}

interface DateFields {
  readonly declared: ReadonlySet<string>
  readonly writers: ReadonlyArray<readonly [string, DateWriter]>
  /** The writer for a key `declared` lacks, when the schema describes one. */
  readonly undeclared: ((key: string) => DateWriter) | undefined
}

/** The writer for an undeclared key: it depends only on which patterns the key matches. */
function undeclaredWriters(nodes: readonly object[], depth: number): (key: string) => DateWriter {
  const sources = new Set<string>()
  for (const node of nodes)
    for (const source of Object.keys(objectField(node, "patternProperties") ?? {}))
      sources.add(source)
  const bySet = new Map<string, DateWriter>()
  return (key) => {
    let matched = ""
    for (const source of sources) matched += patternMatches(source, key) ? "1" : "0"
    let writer = bySet.get(matched)
    if (writer === undefined) {
      writer = compileDates(fieldNodes(nodes, key), depth)
      bySet.set(matched, writer)
    }
    return writer
  }
}

function writeItems(value: readonly unknown[], items: readonly DateWriter[]): unknown {
  const last = items.length - 1
  let out: unknown[] | undefined
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i]
    // Every writer returns a primitive as it came.
    if (typeof item !== "object" || item === null) continue
    const written = (items[i < last ? i : last] ?? WRITE_ALL)(item)
    if (written !== item) out ??= value.slice()
    if (out !== undefined) out[i] = written
  }
  return out ?? value
}

function writeFields(value: object, fields: DateFields): unknown {
  const { declared, writers, undeclared } = fields
  let out: Record<string, unknown> | undefined
  // An index loop: iterating allocates per row. A declared field is read as the validator reads it,
  // a prototype getter included.
  for (let i = 0; i < writers.length; i++) {
    const entry = writers[i]
    if (entry === undefined) continue
    const field: unknown = Reflect.get(value, entry[0])
    if (typeof field !== "object" || field === null) continue
    const written = entry[1](field)
    if (written === field) continue
    out ??= { ...value }
    define(out, entry[0], written)
  }
  if (undeclared !== undefined)
    for (const key of Object.keys(value)) {
      if (declared.has(key)) continue
      const field: unknown = Reflect.get(value, key)
      if (typeof field !== "object" || field === null) continue
      const written = undeclared(key)(field)
      if (written === field) continue
      out ??= { ...value }
      define(out, key, written)
    }
  return out ?? value
}

const MAX_STRIPPED_NAMES = 20
const MAX_NAME_LENGTH = 64
const MAX_REPORTED_SETS = 32

/** Paths in what the handler returned that are absent from what was sent, array items as `name[]`.
 * Stops one past {@link MAX_STRIPPED_NAMES}, so the log can say there were more. */
function collectStripped(sent: unknown, kept: unknown, path: string, out: Set<string>): void {
  if (Array.isArray(sent)) {
    if (!Array.isArray(kept)) return
    const items = `${path}[]`
    for (let i = 0; i < sent.length && i < kept.length; i++) {
      collectStripped(sent[i], kept[i], items, out)
      if (out.size > MAX_STRIPPED_NAMES) return
    }
    return
  }
  if (!isPlainObject(sent) || !isPlainObject(kept)) return
  for (const key of Object.keys(sent)) {
    const short = key.length > MAX_NAME_LENGTH ? `${key.slice(0, MAX_NAME_LENGTH)}...` : key
    const name = path === "" ? short : `${path}.${short}`
    if (!Object.hasOwn(kept, key)) out.add(name)
    else collectStripped(sent[key], kept[key], name, out)
    if (out.size > MAX_STRIPPED_NAMES) return
  }
}

/** The log line for a route's stripped names the first time it sends that set, else `undefined`. */
function firstReport(
  reported: WeakMap<ResponseContractDefinition, Set<string>>,
  definition: ResponseContractDefinition,
  fields: readonly string[],
): string | undefined {
  if (fields.length === 0) return undefined
  let seen = reported.get(definition)
  if (seen === undefined) {
    seen = new Set()
    reported.set(definition, seen)
  }
  const key = fields.join("\n")
  if (seen.size >= MAX_REPORTED_SETS || seen.has(key)) return undefined
  seen.add(key)
  const last =
    seen.size === MAX_REPORTED_SETS ? " Further sets of fields on this route are not logged." : ""
  return `${strippedMessage(fields)}${last}`
}

function strippedMessage(fields: readonly string[]): string {
  const listed =
    fields.length > MAX_STRIPPED_NAMES
      ? `${fields.slice(0, MAX_STRIPPED_NAMES).join(", ")}, and more`
      : fields.join(", ")
  return `response carried fields its contract does not declare: ${listed}. They were not sent.`
}

/** Top-level keys present in the handler's result but absent from the validated value. */
function droppedKeys(result: unknown, value: unknown): string[] {
  if (!isPlainObject(result) || !isPlainObject(value)) return []
  return Object.keys(result).filter((k) => !(k in value))
}

/**
 * Check one result against the route's declared response schema.
 *
 * Returns synchronously when the schema does (the common case), so an app that opts in does not pay a
 * microtask per response for a check that had no work to do.
 */
export function checkResponseContract(
  schema: StandardSchemaV1,
  result: unknown,
  mode: "warn" | "enforce",
  options?: ResponseContractOptions,
): ResponseContractOutcome | Promise<ResponseContractOutcome> {
  return checkRouteResponseContract({ response: schema }, result, mode, undefined, options)
}

/** The schema a reply with this status is held to: `response` for 2xx, else `errors[status]`. */
const schemaFor = (definition: ResponseContractDefinition, code: number) =>
  code >= 200 && code < 300 ? definition.response : definition.errors?.[code]

/** A `c.json(...)` reply rebuilt around its validated value, keeping its status and headers. */
function reserialize(reply: Response, value: unknown): Response {
  const headers = new Headers(reply.headers)
  headers.delete("content-length")
  return new Response(jsonText(value), {
    status: reply.status,
    statusText: reply.statusText,
    headers,
  })
}

/**
 * Check a route's success or status-specific error payload. Plain `status()` results retain their
 * status while enforcement replaces only the body with the validator's output. A `c.json(...)`
 * reply is held to the contract through the value it was built from (`jsonReply`). Any other raw
 * `Response` remains an explicit transport escape hatch because inspecting it would consume
 * streams or alter redirects; assurance/static checks must govern that path separately.
 */
export function checkRouteResponseContract(
  definition: ResponseContractDefinition,
  result: unknown,
  mode: "warn" | "enforce",
  jsonReply?: { readonly body: unknown },
  options?: ResponseContractOptions,
): ResponseContractOutcome | Promise<ResponseContractOutcome> {
  return checkContract(
    definition,
    result,
    mode,
    jsonReply,
    options?.extra === "strip" ? STRIP : KEEP,
  )
}

/** How the plugin holds a payload: projected first or not, and the stripped-field reporter. */
interface ContractPolicy {
  readonly strip: boolean
  /** The message to log for these stripped names, or `undefined` to stay quiet. */
  readonly report: ((fields: readonly string[]) => string | undefined) | undefined
}

const STRIP: ContractPolicy = { strip: true, report: undefined }
const KEEP: ContractPolicy = { strip: false, report: undefined }

function checkContract(
  definition: ResponseContractDefinition,
  result: unknown,
  mode: "warn" | "enforce",
  jsonReply: { readonly body: unknown } | undefined,
  policy: ContractPolicy,
): ResponseContractOutcome | Promise<ResponseContractOutcome> {
  const plain = isResponseResult(result) ? result.plain : undefined
  if (plain !== undefined) {
    const schema = schemaFor(definition, plain.status)
    if (schema === undefined) return { kind: "ok", value: result }
    return validateContract(schema, plain.body, result, mode, policy, (value) =>
      status(
        plain.status,
        value,
        plain.headers === undefined ? undefined : { headers: plain.headers },
      ),
    )
  }
  if (jsonReply !== undefined && result instanceof Response) {
    const schema = schemaFor(definition, result.status)
    if (schema === undefined) return { kind: "ok", value: result }
    return validateContract(schema, jsonReply.body, result, mode, policy, (value) =>
      reserialize(result, value),
    )
  }

  // A handler may return a raw Response as deliberate control flow (a redirect, a stream). There is no
  // JSON payload to hold to the contract, and re-serializing one would corrupt it. A `status(...)` is
  // intentionally handled above because its plain body and status remain available without consuming
  // a stream. An absent body has nothing to validate.
  if (result instanceof Response || result === undefined) return { kind: "ok", value: result }
  const schema = definition.response
  if (schema === undefined) return { kind: "ok", value: result }
  return validateContract(schema, result, result, mode, policy, (value) => value)
}

/** Validate `payload`; `served` is what goes out unchanged when nothing is enforced - the whole
 * `status(...)` result or reply, never just its body. */
function validateContract(
  schema: StandardSchemaV1,
  payload: unknown,
  served: unknown,
  mode: "warn" | "enforce",
  policy: ContractPolicy,
  replace: (value: unknown) => unknown,
): ResponseContractOutcome | Promise<ResponseContractOutcome> {
  const node = jsonSchemaOf(schema)
  // Without a `t.date()` in the schema, a `Date` is a hook like any other: one walk writes them all.
  const dates = node !== undefined && writesDates(node)
  const project = policy.strip && node !== undefined ? projectorOf(node, dates) : undefined
  // Naming what was stripped compares against everything the payload writes, so it walks it whole.
  const hooks =
    project === undefined || policy.report !== undefined || mode === "warn"
      ? hooksOf(payload, dates)
      : 0
  const before = hooks === 0 ? payload : wireValue(payload, "", [], dates)
  // The projection applies the hook of each value it descends into and reads only declared fields,
  // so a quiet strip never enumerates the payload's own keys. What it copies whole is walked after.
  const written =
    project === undefined ? before : wireValueOf(project(writtenAt(before, "", dates)), dates)
  const sent = node === undefined || dates ? written : dateWriterOf(node)(written)
  const settled = schema["~standard"].validate(sent)
  // When hooks wrote the payload, `warn` sends what they wrote here rather than calling them again,
  // so a hook that answers differently on a second call cannot send what was not judged. A `Date`'s
  // own hook always answers the same, so a payload only they wrote is sent as it came.
  const shown = mode === "warn" && hooks === OTHER_HOOK ? replace(before) : served
  return settled instanceof Promise
    ? settled.then((r) => interpret(r, before, shown, mode, replace, policy.report))
    : interpret(settled, before, shown, mode, replace, policy.report)
}

function interpret(
  settled: StandardResult<unknown>,
  payload: unknown,
  served: unknown,
  mode: "warn" | "enforce",
  replace: (value: unknown) => unknown,
  report: ContractPolicy["report"],
): ResponseContractOutcome {
  if (settled.issues !== undefined) {
    const message = `response does not satisfy its declared contract: ${formatStandardIssues(settled.issues)}`
    // `warn` never changes what is served - it reports and gets out of the way, so switching it on can
    // never be the thing that broke production.
    return mode === "warn"
      ? { kind: "warn", value: served, message }
      : { kind: "violation", message }
  }
  if (mode === "enforce") {
    const value = replace(settled.value)
    if (report === undefined) return { kind: "ok", value }
    const stripped = new Set<string>()
    collectStripped(payload, settled.value, "", stripped)
    const message = report([...stripped].sort())
    return message === undefined ? { kind: "ok", value } : { kind: "warn", value, message }
  }
  const dropped = droppedKeys(payload, settled.value)
  return dropped.length === 0
    ? { kind: "ok", value: served }
    : {
        kind: "warn",
        value: served,
        message: `response carries fields its contract does not declare: ${dropped.join(", ")}. They are being sent; \`responseContract("enforce")\` would strip them.`,
        fields: dropped,
      }
}

/**
 * What the server holds when the plugin is installed. The kernel calls `check` through this object and
 * never imports the implementation, so an app that does not install the plugin does not carry it.
 */
export interface ResponseContractRuntime {
  readonly mode: ResponseContractMode
  check(
    definition: ResponseContractDefinition,
    result: unknown,
    context?: {
      readonly req?: Request
      readonly jsonReply?: Response | undefined
      readonly jsonBody?: unknown
    },
  ): ResponseContractOutcome | Promise<ResponseContractOutcome>
}

interface ResponseContractInstallable {
  [INSTALL_RESPONSE_CONTRACT](runtime: ResponseContractRuntime): void
}

/** What the plugin reads off a server it was applied to, to name a route and to log a failing hook. */
interface ContractHost {
  readonly catalog: {
    entries(): readonly {
      readonly method: string
      readonly path: string
      readonly entry: { readonly responseContract?: { readonly definition: object } }
    }[]
  }
  readonly logger: { error(message: string, fields: { detail: string }): void }
}

/**
 * Hold every route's declared `response` schema to what the handler actually returned.
 *
 *     app.use(responseContract("enforce"))                      // a closed t.object -> 500 on extras
 *     app.use(responseContract("enforce", { extra: "strip" }))  // extras dropped, declared fields sent
 *
 * Install it before the routes it should cover - like `idempotency()`, the decision is made per route
 * at registration, so routes registered earlier are not retroactively covered. It covers routes on
 * the server it is installed on, its `group()`s, and servers `merge()`d into it afterwards.
 *
 * The check itself is cheap - with a compiled validator it measures in the ~100ns-per-response
 * range, within benchmark noise of an uncontracted route on any route that carries middleware or a
 * derive. What a contracted route does give up is the bare-route fused lane (the check needs the
 * handler's value before it becomes bytes), which only a route with NO other lifecycle steps was
 * taking anyway. Opt-in because not installing the plugin keeps the lane out of the bundle, not
 * because enforcement is expensive.
 */
export function responseContract(
  mode: ResponseContractMode = "warn",
  options: ResponseContractOptions = {},
): IdentityPlugin {
  if (options.extra !== undefined && options.extra !== "reject" && options.extra !== "strip") {
    throw new TypeError(
      `responseContract(): extra must be "reject" or "strip", got ${JSON.stringify(options.extra)}`,
    )
  }
  if (options.logStripped !== undefined && typeof options.logStripped !== "boolean") {
    throw new TypeError(
      `responseContract(): logStripped must be a boolean, got ${JSON.stringify(options.logStripped)}`,
    )
  }
  const onReport = options.onReport
  const strip = options.extra === "strip"
  const quiet = strip ? STRIP : KEEP
  const reported =
    options.logStripped === true && mode === "enforce"
      ? new WeakMap<ResponseContractDefinition, Set<string>>()
      : undefined
  const hosts: ContractHost[] = []
  // A definition is compiled per route into the catalog of a server this plugin was applied to (a
  // `group()`'s and a `merge()`d server's routes are adopted into it), so the route is found there
  // and naming it costs the kernel nothing.
  const routes = new WeakMap<object, { readonly method: string; readonly path: string }>()
  let failed = false
  // A hook that throws or rejects (or is not a function) is logged once and never reaches a response.
  const fail = (error: unknown): void => {
    if (!failed)
      hosts[0]?.logger.error("response contract onReport threw", { detail: String(error) })
    failed = true
  }
  const runtime: ResponseContractRuntime = {
    mode,
    check: (definition, result, context) => {
      const jsonReply =
        result instanceof Response && result === context?.jsonReply
          ? { body: context.jsonBody }
          : undefined
      const logged =
        reported === undefined
          ? undefined
          : (fields: readonly string[]) => firstReport(reported, definition, fields)
      if (onReport === undefined)
        return checkContract(
          definition,
          result,
          mode,
          jsonReply,
          logged === undefined ? quiet : { strip, report: logged },
        )
      const send = (
        kind: ResponseContractReport["kind"],
        message: string,
        fields?: readonly string[],
      ) => {
        if (!routes.has(definition))
          for (const host of hosts)
            for (const route of host.catalog.entries()) {
              const owned = route.entry.responseContract?.definition
              if (owned !== undefined) routes.set(owned, route)
            }
        const route = routes.get(definition)
        try {
          const returned: unknown = onReport({
            kind,
            method: route?.method ?? "",
            route: route?.path ?? "",
            fields,
            message,
          })
          if (returned instanceof Promise) returned.catch(fail)
        } catch (error) {
          fail(error)
        }
      }
      const outcome = checkContract(definition, result, mode, jsonReply, {
        strip,
        report: (fields) => {
          if (fields.length > 0) send("stripped", strippedMessage(fields), fields)
          return logged?.(fields)
        },
      })
      const observe = (settled: ResponseContractOutcome): ResponseContractOutcome => {
        // An enforce-mode warn is the stripped-field log line, already reported as `stripped`.
        if (settled.kind === "violation") send("violation", settled.message)
        else if (settled.kind === "warn" && mode === "warn")
          send("warn", settled.message, settled.fields)
        return settled
      }
      return outcome instanceof Promise ? outcome.then(observe) : observe(outcome)
    },
  }
  const apply = <S extends AnyServer>(app: S): S => {
    // A server also holds the route catalog and the logger ContractHost reads.
    const host = app as unknown as ResponseContractInstallable & ContractHost
    host[INSTALL_RESPONSE_CONTRACT](runtime)
    if (!hosts.includes(host)) hosts.push(host)
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:response-contract" }) as IdentityPlugin
}

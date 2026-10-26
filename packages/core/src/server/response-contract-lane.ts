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
 * from private state keeps it. A `Date` is judged as the ISO string its own hook writes too, so a
 * `t.string({ format: "date-time" })` or `t.date()` field holding a database timestamp passes: a
 * schema that carries its JSON Schema is checked as JSON carries it. A schema without one (zod,
 * valibot) cannot say which place expects a string, so it is shown every `Date` as one.
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

import { isRecord } from "../internal/record.ts"
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

/** Rebuilds a value with only what its schema declares; absent when the schema can strip nothing. */
type Projector = (value: unknown) => unknown

const projectors = new WeakMap<object, Projector | null>()

/** The projector for a schema's JSON Schema, compiled once per schema. It writes each `Date` as it
 * descends, as every schema that carries its JSON Schema is judged. */
function projectorOf(node: object): Projector | undefined {
  let found = projectors.get(node)
  if (found === undefined) {
    found = compileProjector(node) ?? null
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

function compileProjector(node: unknown): Projector | undefined {
  if (typeof node !== "object" || node === null) return undefined
  const schema: object = node
  const type: unknown = Reflect.get(schema, "type")
  const branches: unknown = Reflect.get(schema, "anyOf") ?? Reflect.get(schema, "oneOf")
  if (Array.isArray(branches)) return compileUnion(branches)
  if (type === "array") {
    const items: unknown = Reflect.get(schema, "items")
    const item = Array.isArray(items) ? undefined : compileProjector(items)
    return item === undefined
      ? undefined
      : (value) => {
          if (!Array.isArray(value)) return value
          const out: unknown[] = []
          for (let i = 0; i < value.length; i++) out.push(item(writtenAt(value[i], i, true)))
          return out
        }
  }
  if (type !== "object") return undefined
  const properties = objectField(schema, "properties") ?? {}
  const keys = Object.keys(properties)
  const nested = new Map<string, Projector>()
  for (const key of keys) {
    const projector = compileProjector(Reflect.get(properties, key))
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
    patterns.push([pattern, compileProjector(child)])
  }
  const closed = Reflect.get(schema, "additionalProperties") === false
  if (!closed && nested.size === 0 && patterns.every(([, projector]) => projector === undefined))
    return undefined
  const declared = new Set(keys)
  return (value) => {
    if (!isRecord(value)) return value
    const out: Record<string, unknown> = closed ? {} : { ...value }
    for (const key of closed ? keys : nested.keys()) {
      if (!hasField(value, key)) continue
      const projector = nested.get(key)
      define(
        out,
        key,
        projector === undefined ? value[key] : projector(writtenAt(value[key], key, true)),
      )
    }
    if (patterns.length > 0) projectPatternKeys(value, out, declared, patterns, closed)
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
function compileUnion(branches: readonly unknown[]): Projector | undefined {
  const objects: object[] = []
  const arrays: object[] = []
  if (!sortBranches(branches, objects, arrays)) return undefined
  const forArray = arrays.length === 1 ? compileProjector(arrays[0]) : undefined
  const forObject =
    objects.length === 1
      ? compileProjector(objects[0])
      : objects.length > 1
        ? compileDiscriminated(objects)
        : undefined
  if (forArray === undefined && forObject === undefined) return undefined
  return (value) => {
    if (Array.isArray(value)) return forArray === undefined ? value : forArray(value)
    return forObject !== undefined && isRecord(value) ? forObject(value) : value
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
function compileDiscriminated(branches: readonly object[]): Projector | undefined {
  const projectors = branches.map((branch) => compileProjector(branch))
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
      if (!isRecord(value) || !hasField(value, key)) return value
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
      define(out, key, projector(writtenAt(value[key], key, true)))
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
// What `Date.prototype.toJSON` reads a `Date`'s time value through.
const DATE_TO_PRIMITIVE = Date.prototype[Symbol.toPrimitive]
const DATE_VALUE_OF = Date.prototype.valueOf

// Deeper than this, the copying walk takes over with its own cycle check.
const MAX_HOOK_SCAN_DEPTH = 64

const isDate = (value: object, hook: unknown): value is Date =>
  hook === DATE_TO_JSON && value instanceof Date

/**
 * Whether `date` reaches the `@@toPrimitive` and `valueOf` that `Date.prototype.toJSON` reads its time
 * value through as they ship, on itself, its class or `Date.prototype`. Then its steps, taken here,
 * give what the call would: `null` for a time value that is not finite, else what its `toISOString`
 * answers, called through it as `toJSON` calls it.
 */
const readsShippedTime = (date: Date): boolean =>
  date[Symbol.toPrimitive] === DATE_TO_PRIMITIVE && date.valueOf === DATE_VALUE_OF

/**
 * Whether `value` holds a `toJSON` hook, a `Date`'s only when `dates` writes them. Stops at the first
 * and allocates nothing: most payloads have none, and this is the price every contracted response
 * pays.
 */
function hasHook(value: object, depth: number, dates: boolean): boolean {
  if (depth > MAX_HOOK_SCAN_DEPTH) return true
  const hook: unknown = Reflect.get(value, "toJSON")
  if (typeof hook === "function") return dates || !isDate(value, hook)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i]
      if (typeof item === "object" && item !== null && hasHook(item, depth + 1, dates)) return true
    }
    return false
  }
  // Inherited enumerable keys are scanned too; that only ever sends a value to the copying walk.
  for (const key in value) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `key` was enumerated from `value`; `Reflect.get` here halves the speed of this for-in.
    const field: unknown = (value as Record<string, unknown>)[key]
    if (typeof field === "object" && field !== null && hasHook(field, depth + 1, dates)) return true
  }
  return false
}

/**
 * What `JSON.stringify` writes for `value`: every `toJSON` hook applied as the serializer applies it,
 * so the contract judges the bytes that go out rather than fields a hook then replaces. Copies only the
 * containers above a hook. A `Date` keeps its object unless `dates`.
 */
const wireValueOf = (value: unknown, dates: boolean): unknown =>
  typeof value === "object" && value !== null && hasHook(value, 0, dates)
    ? wireValue(value, "", [], dates)
    : value

const wireValue = (value: unknown, key: string | number, path: object[], dates: boolean): unknown =>
  wireChildren(writtenAt(value, key, dates), path, dates)

/** `value` as the serializer takes it under `key`: its own hook applied, its fields still as they are. */
function writtenAt(value: unknown, key: string | number, dates: boolean): unknown {
  if (typeof value !== "object" || value === null) return value
  const hook: unknown = Reflect.get(value, "toJSON")
  if (typeof hook !== "function") return value
  if (isDate(value, hook)) {
    if (!dates) return value
    if (readsShippedTime(value))
      return Number.isFinite(value.valueOf()) ? value.toISOString() : null
  }
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

/** `value` with each of its fields written; a container is copied once, when a first field changes. */
function wireChildren(value: unknown, path: object[], dates: boolean): unknown {
  // A cycle is left as it is for `JSON.stringify` to refuse.
  if (typeof value !== "object" || value === null || path.includes(value)) return value
  path.push(value)
  // A primitive is written as it is, so only an object field is walked.
  if (Array.isArray(value)) {
    let items: unknown[] | undefined
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i]
      if (typeof item !== "object" || item === null) continue
      const written = wireValue(item, i, path, dates)
      if (written === item) continue
      items ??= value.slice()
      items[i] = written
    }
    path.pop()
    return items ?? value
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every key read below comes from `Object.keys(value)`; `Reflect.get` costs a call per field.
  const record = value as Record<string, unknown>
  let out: Record<string, unknown> | undefined
  for (const name of Object.keys(record)) {
    const field = record[name]
    if (typeof field !== "object" || field === null) continue
    const written = wireValue(field, name, path, dates)
    if (written === field) continue
    // A spread copies the own enumerable fields JSON writes, faster than one assignment each.
    out ??= { ...record }
    define(out, name, written)
  }
  path.pop()
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
  if (!isRecord(sent) || !isRecord(kept)) return
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
  if (!isRecord(result) || !isRecord(value)) return []
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

/** Set by `@nifrajs/schema` on the validate of a `t` schema with a `t.date()`: the check for a value
 * as JSON writes it. */
const VALIDATE_WIRE: unique symbol = Symbol.for("nifra.schema.validateWire")

type ContractValidate = StandardSchemaV1["~standard"]["validate"] & {
  readonly [VALIDATE_WIRE]?: unknown
}

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
  // A `Date` is a hook like any other for a schema that carries its JSON Schema: one walk writes them.
  const dates = node !== undefined
  const project = policy.strip && node !== undefined ? projectorOf(node) : undefined
  // Naming what was stripped compares against everything the payload writes, so it walks it whole.
  const hooks =
    (project === undefined || policy.report !== undefined || mode === "warn") &&
    typeof payload === "object" &&
    payload !== null &&
    hasHook(payload, 0, dates)
  const before = hooks ? wireValue(payload, "", [], dates) : payload
  // The projection applies the hook of each value it descends into and reads only declared fields,
  // so a quiet strip never enumerates the payload's own keys. What it copies whole is walked after.
  const sent =
    project === undefined ? before : wireValueOf(project(writtenAt(before, "", true)), true)
  // A `t` schema's check for a value as JSON carries it: its `t.date()` strings stay strings, where
  // the plain validate would hand back the `Date`s a request's handler receives.
  const validate: ContractValidate = schema["~standard"].validate
  const wire = validate[VALIDATE_WIRE]
  const settled: StandardResult<unknown> | Promise<StandardResult<unknown>> =
    typeof wire === "function" ? wire(sent) : schema["~standard"].validate(sent)
  // When hooks wrote the payload, `warn` sends what they wrote here rather than calling them again:
  // a hook that answers differently on a second call cannot send what was not judged, and the
  // serializer does not write a `Date` twice. A contracted route's `c.json` reply has none left, as
  // `write` applied them when the reply was built.
  const shown = mode === "warn" && hooks ? replace(before) : served
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
  /**
   * What a `c.json(body)` reply with this status writes, each `toJSON` hook applied as `check` judges
   * it, so the reply's bytes and its check share one call of each. Without it, as from a plugin of
   * an older copy of core, the reply writes `body` as given.
   */
  write?(definition: ResponseContractDefinition, body: unknown, status: number | undefined): unknown
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
    write: (definition, body, status) => {
      const schema = schemaFor(definition, status ?? 200)
      return schema === undefined ? body : wireValueOf(body, jsonSchemaOf(schema) !== undefined)
    },
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

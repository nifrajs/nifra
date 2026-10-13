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
 * ## What enforcement costs
 *
 * Less than it looks like it should. With a compiled validator (`@nifrajs/schema`'s `t` compiles at
 * construction; zod/valibot equivalents are similarly cheap), the check itself measures in the
 * ~100ns-per-response range - on a realistic middleware-carrying route, enforce mode benchmarks
 * within measurement noise of the same route with no contract at all, on Bun and Node alike. The
 * one real cost is structural: a contracted route cannot take the bare-route fused lane, because
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
   * `logStripped`) the cleaned one. */
  | { readonly kind: "warn"; readonly value: unknown; readonly message: string }
  /** `enforce` only: the payload cannot be reconciled with the contract, so it must not be sent. */
  | { readonly kind: "violation"; readonly message: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Rebuilds a value with only what its schema declares; absent when the schema can strip nothing. */
type Projector = (value: unknown) => unknown

const projectors = new WeakMap<object, Projector | null>()

/** The projector for a schema's JSON Schema, compiled once per schema. */
function projectorOf(schema: StandardSchemaV1): Projector | undefined {
  const node: unknown = Reflect.get(schema, "jsonSchema")
  if (typeof node !== "object" || node === null) return undefined
  let found = projectors.get(node)
  if (found === undefined) {
    found = compileProjector(node) ?? null
    projectors.set(node, found)
  }
  return found ?? undefined
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
      : (value) => (Array.isArray(value) ? value.map(item) : value)
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
    if (!isPlainObject(value)) return value
    const out: Record<string, unknown> = closed ? {} : { ...value }
    for (const key of closed ? keys : nested.keys()) {
      if (!hasField(value, key)) continue
      const projector = nested.get(key)
      define(out, key, projector === undefined ? value[key] : projector(value[key]))
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
    if (matches === 1 && projector !== undefined) define(out, key, projector(value[key]))
    else if (closed) define(out, key, value[key])
  }
}

/** `__proto__` is a declared name like any other here; plain assignment would set the prototype. */
function define(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__")
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  else out[key] = value
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
  const listed =
    fields.length > MAX_STRIPPED_NAMES
      ? `${fields.slice(0, MAX_STRIPPED_NAMES).join(", ")}, and more`
      : fields.join(", ")
  const last =
    seen.size === MAX_REPORTED_SETS ? " Further sets of fields on this route are not logged." : ""
  return `response carried fields its contract does not declare: ${listed}. They were not sent.${last}`
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
  return new Response(JSON.stringify(value), {
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
  const project = policy.strip ? projectorOf(schema) : undefined
  const settled = schema["~standard"].validate(project === undefined ? payload : project(payload))
  return settled instanceof Promise
    ? settled.then((r) => interpret(r, payload, served, mode, replace, policy.report))
    : interpret(settled, payload, served, mode, replace, policy.report)
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
    context?: { readonly jsonReply?: Response | undefined; readonly jsonBody?: unknown },
  ): ResponseContractOutcome | Promise<ResponseContractOutcome>
}

interface ResponseContractInstallable {
  [INSTALL_RESPONSE_CONTRACT](runtime: ResponseContractRuntime): void
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
  const strip = options.extra === "strip"
  const quiet = strip ? STRIP : KEEP
  const reported =
    options.logStripped === true && mode === "enforce"
      ? new WeakMap<ResponseContractDefinition, Set<string>>()
      : undefined
  const runtime: ResponseContractRuntime = {
    mode,
    check: (definition, result, context) =>
      checkContract(
        definition,
        result,
        mode,
        result instanceof Response && result === context?.jsonReply
          ? { body: context.jsonBody }
          : undefined,
        reported === undefined
          ? quiet
          : { strip, report: (fields) => firstReport(reported, definition, fields) },
      ),
  }
  const apply = <S extends AnyServer>(app: S): S => {
    ;(app as unknown as ResponseContractInstallable)[INSTALL_RESPONSE_CONTRACT](runtime)
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:response-contract" }) as IdentityPlugin
}

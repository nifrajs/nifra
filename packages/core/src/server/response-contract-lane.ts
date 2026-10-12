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
   * only when exactly one branch can hold an object. Schemas without `jsonSchema` (zod, valibot) are
   * unaffected: they already strip or reject by their own rules.
   */
  readonly extra?: "reject" | "strip"
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
  /** `warn` only: the payload differed from the contract. The ORIGINAL result is still served. */
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

const canHoldObject = (node: object): boolean => {
  const type: unknown = Reflect.get(node, "type")
  return type === undefined || type === "object" || type === "array"
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
  if (Array.isArray(branches)) {
    // Which branch a value meets is the validator's call; projecting onto one of two object branches
    // could strip the fields that make the other match.
    const holders = branches.filter(
      (branch): branch is object =>
        typeof branch === "object" && branch !== null && canHoldObject(branch),
    )
    const only = holders.length === 1 ? compileProjector(holders[0]) : undefined
    return only === undefined
      ? undefined
      : (value) => (typeof value === "object" && value !== null ? only(value) : value)
  }
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
      // A getter on a row class's prototype is a declared field; `Object.prototype`'s members are not.
      if (!Object.hasOwn(value, key) && (!(key in value) || key in Object.prototype)) continue
      const projector = nested.get(key)
      define(out, key, projector === undefined ? value[key] : projector(value[key]))
    }
    if (patterns.length > 0) projectPatternKeys(value, out, declared, patterns, closed)
    return out
  }
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
  const strip = options?.extra === "strip"
  const plain = isResponseResult(result) ? result.plain : undefined
  if (plain !== undefined) {
    const schema = schemaFor(definition, plain.status)
    if (schema === undefined) return { kind: "ok", value: result }
    return validateContract(schema, plain.body, result, mode, strip, (value) =>
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
    return validateContract(schema, jsonReply.body, result, mode, strip, (value) =>
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
  return validateContract(schema, result, result, mode, strip, (value) => value)
}

/** Validate `payload`; `served` is what goes out unchanged when nothing is enforced - the whole
 * `status(...)` result or reply, never just its body. */
function validateContract(
  schema: StandardSchemaV1,
  payload: unknown,
  served: unknown,
  mode: "warn" | "enforce",
  strip: boolean,
  replace: (value: unknown) => unknown,
): ResponseContractOutcome | Promise<ResponseContractOutcome> {
  const project = strip ? projectorOf(schema) : undefined
  const settled = schema["~standard"].validate(project === undefined ? payload : project(payload))
  return settled instanceof Promise
    ? settled.then((r) => interpret(r, payload, served, mode, replace))
    : interpret(settled, payload, served, mode, replace)
}

function interpret(
  settled: StandardResult<unknown>,
  payload: unknown,
  served: unknown,
  mode: "warn" | "enforce",
  replace: (value: unknown) => unknown,
): ResponseContractOutcome {
  if (settled.issues !== undefined) {
    const message = `response does not satisfy its declared contract: ${formatStandardIssues(settled.issues)}`
    // `warn` never changes what is served - it reports and gets out of the way, so switching it on can
    // never be the thing that broke production.
    return mode === "warn"
      ? { kind: "warn", value: served, message }
      : { kind: "violation", message }
  }
  const dropped = droppedKeys(payload, settled.value)
  if (mode === "enforce") return { kind: "ok", value: replace(settled.value) }
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
  const contractOptions = options.extra === "strip" ? options : undefined
  const runtime: ResponseContractRuntime = {
    mode,
    check: (definition, result, context) =>
      checkRouteResponseContract(
        definition,
        result,
        mode,
        result instanceof Response && result === context?.jsonReply
          ? { body: context.jsonBody }
          : undefined,
        contractOptions,
      ),
  }
  const apply = <S extends AnyServer>(app: S): S => {
    ;(app as unknown as ResponseContractInstallable)[INSTALL_RESPONSE_CONTRACT](runtime)
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:response-contract" }) as IdentityPlugin
}

/**
 * The data guard. Every value a loader, action, boundary loader or server function sends toward the
 * browser passes through its declared output schema first:
 *
 * - keys the schema does not declare are dropped - that is the guarantee, and it holds even when the
 *   schema itself would accept them;
 * - a declared field of the wrong shape fails the request, and the error names field paths only,
 *   never a value;
 * - a deferred value must be declared as one (`t.deferred(inner)`), and its resolved value is guarded
 *   by `inner` before it streams.
 *
 * Projection reads the schema's JSON Schema: a nifra schema's `jsonSchema`, or a Standard JSON Schema
 * (`~standard.jsonSchema.output`). A schema that exposes neither is trusted to strip unknown keys in
 * its own `validate` output, as zod and valibot objects do by default.
 */
import type { StandardResult, StandardSchemaV1 } from "@nifrajs/core/server"

// Registry symbols shared with core and `@nifrajs/schema`, so two copies of either still agree.
const RESPONSE_RESULT = Symbol.for("nifra.response.result")
const STATUS_SIGNAL = Symbol.for("nifra.web.status-signal")
/** Set by `t.deferred(inner)` on its schema node: `inner`'s own validate. */
const DEFERRED_VALIDATE = Symbol.for("nifra.schema.deferredValidate")

export const DECLASSIFIED_KEY = "x-nifra-declassified"
const DEFERRED_KEY = "x-nifra-deferred"

/** A field name that usually holds a credential or personal identifier. */
export function isSensitiveFieldName(name: string): boolean {
  const key = name.toLowerCase().replace(/[-_]/g, "")
  return SENSITIVE_NAMES.has(key) || SENSITIVE_SUFFIXES.some((suffix) => key.endsWith(suffix))
}

const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  "passwd",
  "token",
  "sessionid",
  "ssn",
  "socialsecuritynumber",
  "creditcard",
  "creditcardnumber",
  "cardnumber",
  "cvv",
  "cvc",
  "otp",
])
const SENSITIVE_SUFFIXES: readonly string[] = [
  "password",
  "passwordhash",
  "secret",
  "apikey",
  "apitoken",
  "privatekey",
  "secretkey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "sessiontoken",
  "bearertoken",
]

/** A browser-bound value failed its output contract. The message carries paths, never values. */
export class OutputGuardError extends Error {
  override readonly name = "OutputGuardError"
  readonly paths: readonly string[]
  constructor(message: string, paths: readonly string[] = []) {
    super(`[nifra/web] ${message}`)
    this.paths = paths
  }
}

type Node = { readonly [key: string]: unknown }
interface RunState {
  readonly label: string
  readonly issues: string[]
}
type Project = (value: unknown, state: RunState) => unknown

interface CompiledGuard {
  /** Undefined when the schema exposes no JSON Schema to project by. */
  readonly project: Project | undefined
  readonly validate: StandardSchemaV1["~standard"]["validate"]
}

interface Deferred {
  readonly __nifra_deferred: true
  readonly id: number
  readonly promise: Promise<unknown>
}

const isDeferred = (value: unknown): value is Deferred =>
  typeof value === "object" &&
  value !== null &&
  (value as { __nifra_deferred?: unknown }).__nifra_deferred === true

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isPlain = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Re-root the issues children pushed since `from` under `key`. Runs only on failure. */
function prefix(state: RunState, from: number, key: string | number): void {
  for (let i = from; i < state.issues.length; i++) state.issues[i] = `/${key}${state.issues[i]}`
}

function assign(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  } else out[key] = value
}

/** Every deferred marker inside a value no schema declares as deferred is an issue. */
const UNKNOWN: Project = (value, state) => {
  if (typeof value !== "object" || value === null) return value
  if (isDeferred(value)) {
    state.issues.push("")
    return value
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const from = state.issues.length
      UNKNOWN(value[i], state)
      if (state.issues.length > from) prefix(state, from, i)
    }
  } else if (isPlain(value)) {
    for (const key of Object.keys(value)) {
      const from = state.issues.length
      UNKNOWN((value as Record<string, unknown>)[key], state)
      if (state.issues.length > from) prefix(state, from, key)
    }
  }
  return value
}

/**
 * A scalar schema: the validator decides, and a deferred marker cannot pass a scalar check. A `Date`
 * becomes what JSON makes of it (its ISO string), so a `t.string()` field accepts a timestamp column
 * and the page renders on the server with the value the browser receives.
 */
const LEAF: Project = (value) => (value instanceof Date ? value.toJSON() : value)

/** An array whose items are all scalars, passed through whole. */
const LEAF_ARRAY: Project = (value) => value

const typesOf = (node: Node): readonly unknown[] | undefined =>
  Array.isArray(node.type) ? node.type : node.type === undefined ? undefined : [node.type]

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const

/** What a schema node (with no `$ref` or combinator) projects as. */
function shapeOf(node: Node): "deferred" | "object" | "array" | "both" | "leaf" | "unknown" {
  if (node[DEFERRED_KEY] === true) return "deferred"
  const types = typesOf(node)
  const object =
    types?.includes("object") === true ||
    (types === undefined &&
      (node.properties !== undefined ||
        node.patternProperties !== undefined ||
        node.additionalProperties !== undefined))
  const array =
    types?.includes("array") === true ||
    (types === undefined && (node.items !== undefined || node.prefixItems !== undefined))
  if (object && array) return "both"
  if (object) return "object"
  if (array) return "array"
  return types !== undefined ||
    node.const !== undefined ||
    node.enum !== undefined ||
    node.not !== undefined
    ? "leaf"
    : "unknown"
}

class Compiler {
  private readonly memo = new Map<Node, Project>()
  private readonly ids = new Map<string, Node>()
  readonly sensitive: string[] = []

  constructor(private readonly root: Node) {
    this.collectIds(root, new Set())
  }

  private collectIds(value: unknown, seen: Set<unknown>): void {
    if (typeof value !== "object" || value === null || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) this.collectIds(item, seen)
      return
    }
    const id = (value as Node).$id
    if (typeof id === "string" && !this.ids.has(id)) this.ids.set(id, value as Node)
    for (const key of Object.keys(value)) this.collectIds((value as Node)[key], seen)
  }

  private resolve(ref: string, where: string): Node {
    const byId = this.ids.get(ref)
    if (byId !== undefined) return byId
    if (ref === "#") return this.root
    if (ref.startsWith("#/")) {
      let node: unknown = this.root
      for (const raw of ref.slice(2).split("/")) {
        const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~")
        node = isNode(node) ? node[segment] : undefined
      }
      if (isNode(node)) return node
    }
    throw new OutputGuardError(
      `the output schema references "${ref}" at ${where || "/"}, which it does not define`,
    )
  }

  compile(node: Node, where: string): Project {
    const known = this.memo.get(node)
    if (known !== undefined) return known
    let impl: Project = LEAF
    const late: Project = (value, state) => impl(value, state)
    this.memo.set(node, late)
    impl = this.build(node, where)
    this.memo.set(node, impl)
    return impl
  }

  private build(node: Node, where: string): Project {
    if (typeof node.$ref === "string") return this.compile(this.resolve(node.$ref, where), where)
    if (COMBINATORS.some((key) => Array.isArray(node[key]))) return this.merged(node, where)
    switch (shapeOf(node)) {
      case "deferred":
        return this.deferred(node, where)
      case "both":
        return this.dispatch(this.object(node, where), this.array(node, where), undefined)
      case "object":
        return this.object(node, where)
      case "array":
        return this.array(node, where)
      case "leaf":
        return LEAF
      default:
        return UNKNOWN
    }
  }

  private extra(schema: unknown, where: string): Project | undefined {
    if (schema === true || (isNode(schema) && Object.keys(schema).length === 0)) return UNKNOWN
    return isNode(schema) ? this.compile(schema, `${where}/*`) : undefined
  }

  private object(node: Node, where: string): Project {
    const declared = new Map<string, Project>()
    for (const [key, sub] of Object.entries(isNode(node.properties) ? node.properties : {})) {
      if (!isNode(sub)) continue
      if (isSensitiveFieldName(key) && typeof sub[DECLASSIFIED_KEY] !== "string") {
        this.sensitive.push(`${where}/${key}`)
      }
      declared.set(key, this.compile(sub, `${where}/${key}`))
    }
    const patterns: Array<readonly [RegExp, Project]> = []
    for (const [pattern, sub] of Object.entries(
      isNode(node.patternProperties) ? node.patternProperties : {},
    )) {
      if (isNode(sub)) patterns.push([new RegExp(pattern, "u"), this.compile(sub, `${where}/*`)])
    }
    // Undeclared means dropped. Only an explicit `true` or schema keeps extra keys open.
    const extra =
      this.extra(node.additionalProperties, where) ??
      (node.additionalProperties === undefined
        ? this.extra(node.unevaluatedProperties, where)
        : undefined)
    const open = extra !== undefined || patterns.length > 0
    const undeclared = (key: string): Project | undefined => {
      for (const [pattern, project] of patterns) if (pattern.test(key)) return project
      return extra
    }
    // A closed object drops a deferred marker's keys unless it declares them, so only an open one, or
    // one declaring the marker key, could pass a marker on.
    const checksMarker = open || declared.has("__nifra_deferred")
    const project: Project = (value, state) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value
      if (checksMarker && isDeferred(value)) {
        state.issues.push("")
        return value
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        if (value instanceof Date) return value.toJSON()
        // A class instance: its own fields as a plain object, so no prototype `toJSON` or getter
        // decides what is serialized.
        const snapshot: Record<string, unknown> = {}
        for (const key of Object.keys(value))
          assign(snapshot, key, (value as Record<string, unknown>)[key])
        return project(snapshot, state)
      }
      const input = value as Record<string, unknown>
      // Copy-on-write: a value that already holds only declared keys is returned as it is.
      let out: Record<string, unknown> | undefined
      for (const key in input) {
        // An inherited enumerable key (a polluted prototype) is never data.
        if (!Object.hasOwn(input, key)) continue
        const projector = declared.get(key) ?? (open ? undeclared(key) : undefined)
        if (projector === undefined) {
          out ??= copyBefore(input, key)
          continue
        }
        const before = input[key]
        if (projector === LEAF_ARRAY || (projector === LEAF && !(before instanceof Date))) {
          if (out !== undefined) assign(out, key, before)
          continue
        }
        const from = state.issues.length
        const after = projector(before, state)
        if (state.issues.length > from) prefix(state, from, key)
        if (out !== undefined) assign(out, key, after)
        else if (after !== before) {
          out = copyBefore(input, key)
          assign(out, key, after)
        }
      }
      return out ?? value
    }
    return project
  }

  private array(node: Node, where: string): Project {
    const prefixNodes = Array.isArray(node.prefixItems)
      ? node.prefixItems
      : Array.isArray(node.items)
        ? node.items
        : []
    const head = prefixNodes.map((sub, i) =>
      isNode(sub) ? this.compile(sub, `${where}/${i}`) : UNKNOWN,
    )
    const restSchema = Array.isArray(node.items) ? node.additionalItems : node.items
    const rest = this.extra(restSchema, where) ?? UNKNOWN
    // An array of scalars is the validator's alone: no key to drop, and walking it here would cost
    // every `string[]` a loop. A `Date` inside one reaches the validator as it is.
    if (rest === LEAF && head.every((projector) => projector === LEAF)) return LEAF_ARRAY
    return (value, state) => {
      if (!Array.isArray(value)) return value
      let out: unknown[] | undefined
      for (let i = 0; i < value.length; i++) {
        const before = value[i]
        const projector = head[i] ?? rest
        if (projector === LEAF && !(before instanceof Date)) {
          if (out !== undefined) out[i] = before
          continue
        }
        const from = state.issues.length
        const after = projector(before, state)
        if (state.issues.length > from) prefix(state, from, i)
        if (out !== undefined) out[i] = after
        else if (after !== before) {
          out = value.slice(0, i)
          out[i] = after
        }
      }
      return out ?? value
    }
  }

  /** The branches of a union or intersection, flattened, `$ref`s resolved. */
  private branches(node: Node, where: string, into: Node[], seen: Set<Node>): void {
    if (seen.has(node)) return
    seen.add(node)
    if (typeof node.$ref === "string") {
      this.branches(this.resolve(node.$ref, where), where, into, seen)
      return
    }
    let combined = false
    const own: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if ((COMBINATORS as readonly string[]).includes(key) && Array.isArray(value)) {
        combined = true
        for (const branch of value) if (isNode(branch)) this.branches(branch, where, into, seen)
      } else own[key] = value
    }
    if (!combined) into.push(node)
    else if (
      own.type !== undefined ||
      own.properties !== undefined ||
      own.patternProperties !== undefined ||
      own.additionalProperties !== undefined ||
      own.items !== undefined ||
      own.prefixItems !== undefined
    ) {
      into.push(own)
    }
  }

  /**
   * A union or intersection keeps a key when any branch declares it. That can keep a key a
   * different branch than the one the value matches declares - still a declared name, and a strict
   * branch then fails validation - but never an undeclared one.
   */
  private merged(node: Node, where: string): Project {
    const branches: Node[] = []
    this.branches(node, where, branches, new Set())
    const kinds = branches.map(shapeOf)
    if (kinds.includes("unknown")) return UNKNOWN
    const deferreds = branches.filter((_, i) => kinds[i] === "deferred")
    if (deferreds.length > 1) {
      throw new OutputGuardError(
        `the output schema at ${where || "/"} unions more than one deferred value`,
      )
    }
    const objects = branches.filter((_, i) => kinds[i] === "object" || kinds[i] === "both")
    const arrays = branches.filter((_, i) => kinds[i] === "array" || kinds[i] === "both")
    const deferred = deferreds[0]
    return this.dispatch(
      objects.length === 0 ? undefined : this.object(mergeObjects(objects), where),
      arrays.length === 0 ? undefined : this.array(mergeArrays(arrays), where),
      deferred === undefined ? undefined : this.compile(deferred, where),
    )
  }

  private dispatch(
    object: Project | undefined,
    array: Project | undefined,
    deferred: Project | undefined,
  ): Project {
    return (value, state) => {
      if (typeof value !== "object" || value === null) return value
      if (value instanceof Date) return value.toJSON()
      if (Array.isArray(value)) return array === undefined ? value : array(value, state)
      if (isDeferred(value)) {
        if (deferred !== undefined) return deferred(value, state)
        state.issues.push("")
        return value
      }
      return object === undefined ? value : object(value, state)
    }
  }

  private deferred(node: Node, where: string): Project {
    const validate = (node as { readonly [DEFERRED_VALIDATE]?: unknown })[DEFERRED_VALIDATE]
    if (!isNode(node.inner) || typeof validate !== "function") {
      throw new OutputGuardError(
        `the deferred value at ${where || "/"} has no inner schema; declare it with t.deferred(schema)`,
      )
    }
    const inner: CompiledGuard = {
      project: this.compile(node.inner, where),
      validate: validate as CompiledGuard["validate"],
    }
    return (value, state) => {
      if (!isDeferred(value)) return value
      const label = `${state.label}, deferred value ${where || "/"},`
      const promise = value.promise.then((resolved) => runGuard(inner, resolved, label))
      // Claimed like `defer()` claims its own: the stream consumer attaches later.
      void promise.catch(() => {})
      return { __nifra_deferred: true, id: value.id, promise }
    }
  }
}

/** The keys of a plain object before `stop`, every one of them kept as it is. */
function copyBefore(input: Record<string, unknown>, stop: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key in input) {
    if (key === stop) break
    if (Object.hasOwn(input, key)) assign(out, key, input[key])
  }
  return out
}

function mergeObjects(branches: readonly Node[]): Node {
  const properties = new Map<string, Node[]>()
  const patterns = new Map<string, Node[]>()
  const extras: Node[] = []
  let open = false
  for (const branch of branches) {
    if (isNode(branch.properties)) {
      for (const [key, sub] of Object.entries(branch.properties)) {
        if (isNode(sub)) properties.set(key, [...(properties.get(key) ?? []), sub])
      }
    }
    if (isNode(branch.patternProperties)) {
      for (const [pattern, sub] of Object.entries(branch.patternProperties)) {
        if (isNode(sub)) patterns.set(pattern, [...(patterns.get(pattern) ?? []), sub])
      }
    }
    const extra = branch.additionalProperties ?? branch.unevaluatedProperties
    if (extra === true) open = true
    else if (isNode(extra)) extras.push(extra)
  }
  const one = (subs: readonly Node[]): Node => {
    if (subs.length === 1) return subs[0] as Node
    // Declassified only when every branch declassifies the field.
    const reason = subs.every((sub) => typeof sub[DECLASSIFIED_KEY] === "string")
      ? subs[0]?.[DECLASSIFIED_KEY]
      : undefined
    return reason === undefined ? { anyOf: subs } : { anyOf: subs, [DECLASSIFIED_KEY]: reason }
  }
  return {
    type: "object",
    properties: Object.fromEntries([...properties].map(([key, subs]) => [key, one(subs)])),
    patternProperties: Object.fromEntries([...patterns].map(([key, subs]) => [key, one(subs)])),
    ...(open
      ? { additionalProperties: true }
      : extras.length > 0
        ? { additionalProperties: one(extras) }
        : {}),
  }
}

function mergeArrays(branches: readonly Node[]): Node {
  const items: Node[] = []
  let open = false
  for (const branch of branches) {
    const item = Array.isArray(branch.items) ? undefined : branch.items
    if (item === undefined || item === true) open = true
    else if (isNode(item)) items.push(item)
    // A tuple branch: its positions merge into the shared item schema.
    for (const sub of [
      ...(Array.isArray(branch.prefixItems) ? branch.prefixItems : []),
      ...(Array.isArray(branch.items) ? branch.items : []),
    ]) {
      if (isNode(sub)) items.push(sub)
    }
  }
  return {
    type: "array",
    ...(open ? {} : { items: items.length === 1 ? items[0] : { anyOf: items } }),
  }
}

/** The JSON Schema a schema exposes to project by, if any. */
function jsonSchemaOf(schema: StandardSchemaV1): Node | undefined {
  const own = (schema as { readonly jsonSchema?: unknown }).jsonSchema
  if (isNode(own)) return own
  const standard = schema["~standard"] as {
    readonly jsonSchema?: { readonly output?: (options: { target: string }) => unknown }
  }
  if (typeof standard.jsonSchema?.output !== "function") return undefined
  try {
    const out = standard.jsonSchema.output({ target: "draft-2020-12" })
    return isNode(out) ? out : undefined
  } catch {
    return undefined
  }
}

const compiled = new WeakMap<object, CompiledGuard>()

/**
 * Prepare `schema` as the output contract of `owner`. Throws when the schema declares a sensitive
 * field it does not declassify, or references a definition it lacks - at route load, not per request.
 */
export function outputGuard(schema: unknown, owner: string, exportName: string): CompiledGuard {
  if (
    typeof schema !== "object" ||
    schema === null ||
    typeof (schema as StandardSchemaV1)["~standard"]?.validate !== "function"
  ) {
    throw new OutputGuardError(`${owner} exports ${exportName} that is not a Standard Schema`)
  }
  const cached = compiled.get(schema)
  if (cached !== undefined) return cached
  const standard = schema as StandardSchemaV1
  const json = jsonSchemaOf(standard)
  let project: Project | undefined
  if (json !== undefined) {
    const compiler = new Compiler(json)
    project = compiler.compile(json, "")
    if (compiler.sensitive.length > 0) {
      throw new OutputGuardError(
        `${owner} declares sensitive field(s) ${compiler.sensitive.join(", ")} in ${exportName}. Remove them, or mark a field that must reach the browser with t.declassified("why it may", schema)`,
        compiler.sensitive,
      )
    }
  }
  const guard: CompiledGuard = { project, validate: standard["~standard"].validate }
  compiled.set(schema, guard)
  return guard
}

const pathOf = (issue: { readonly path?: ReadonlyArray<unknown> | undefined }): string =>
  (issue.path ?? [])
    .map(
      (segment) =>
        `/${String(typeof segment === "object" && segment !== null ? (segment as { key: unknown }).key : segment)}`,
    )
    .join("") || "/"

function settle(guard: CompiledGuard, result: StandardResult<unknown>, label: string): unknown {
  if (result.issues !== undefined) {
    const paths = [...new Set(result.issues.map(pathOf))]
    throw new OutputGuardError(
      `${label} does not match its output schema at: ${paths.join(", ")}`,
      paths,
    )
  }
  if (guard.project === undefined) {
    const state: RunState = { label, issues: [] }
    UNKNOWN(result.value, state)
    if (state.issues.length > 0) throw undeclaredDeferred(label, state.issues)
  }
  return result.value
}

const undeclaredDeferred = (label: string, paths: readonly string[]): OutputGuardError =>
  new OutputGuardError(
    `${label} returns a deferred value its output schema does not declare at: ${paths.map((p) => p || "/").join(", ")}. Declare it with t.deferred(schema)`,
    paths,
  )

/** Project `value` through `guard`, then validate it. Throws (or rejects) an {@link OutputGuardError}. */
export function runGuard(guard: CompiledGuard, value: unknown, label: string): unknown {
  let projected = value
  if (guard.project !== undefined) {
    const state: RunState = { label, issues: [] }
    projected = guard.project(value, state)
    if (state.issues.length > 0) throw undeclaredDeferred(label, state.issues)
  }
  const result = guard.validate(projected)
  return result instanceof Promise
    ? result.then((settled) => settle(guard, settled, label))
    : settle(guard, result, label)
}

/** What a browser-bound channel sends, and how it is named in errors. */
export interface ChannelContract {
  /** `the loader of "blog/[slug].tsx"` */
  readonly label: string
  readonly guard: CompiledGuard | undefined
  /** Where the missing schema goes, for the error when data arrives without one. */
  readonly missing: string
  /** An action may wrap its data in `revalidate(paths, data)`. */
  readonly revalidate?: boolean
}

const isResponseResult = (
  value: object,
): value is { readonly plain?: { readonly status: number }; toResponse(): Response } =>
  (value as { readonly [RESPONSE_RESULT]?: unknown })[RESPONSE_RESULT] === true &&
  typeof (value as { readonly toResponse?: unknown }).toResponse === "function"

/**
 * Guard one value a channel produced. Nothing, a redirect and an error status pass as they are; a 2xx
 * `Response` is refused because its body would reach the browser without passing the schema.
 */
export function guardValue(contract: ChannelContract, value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (typeof value === "object") {
    let status: number | undefined
    if (value instanceof Response) status = STATUS_SIGNAL in value ? undefined : value.status
    else if (isResponseResult(value)) status = value.plain?.status ?? value.toResponse().status
    else if (contract.revalidate === true && "__nifraRevalidate" in value) {
      const wrapper = value as { readonly data?: unknown }
      const data = guardValue(contract, wrapper.data)
      return data instanceof Promise
        ? data.then((settled) => ({ ...wrapper, data: settled }))
        : { ...wrapper, data }
    }
    if (status !== undefined && status >= 200 && status < 300) {
      throw new OutputGuardError(
        `${contract.label} returned a ${status} Response, whose body would reach the browser without passing its output schema. Return the data itself, or serve the endpoint from backend/app.ts`,
      )
    }
    if (value instanceof Response || isResponseResult(value)) return value
  }
  if (contract.guard === undefined) {
    throw new OutputGuardError(
      `${contract.label} returned data, but declares no output schema. Every value sent to the browser needs one: ${contract.missing}`,
    )
  }
  return runGuard(contract.guard, value, contract.label)
}

/**
 * Wrap a channel function so everything it returns passes {@link guardValue}. A scalar result stays
 * synchronous; an object result settles through a promise, as `await` would. A thrown `Response` is
 * the same answer as a returned one, so a thrown 2xx is refused as well.
 */
export function guardChannel<Args extends unknown[]>(
  fn: (...args: Args) => unknown,
  contract: ChannelContract,
): (...args: Args) => unknown {
  const check = (value: unknown): unknown => guardValue(contract, value)
  const checkThrown = (error: unknown): never => {
    if (
      typeof error === "object" &&
      error !== null &&
      (error instanceof Response || isResponseResult(error))
    )
      guardValue(contract, error)
    throw error
  }
  return (...args) => {
    let value: unknown
    try {
      value = fn(...args)
    } catch (error) {
      return checkThrown(error)
    }
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? Promise.resolve(value).then(check, checkThrown)
      : check(value)
  }
}

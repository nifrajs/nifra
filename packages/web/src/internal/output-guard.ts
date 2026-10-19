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
 *
 * Validation then runs on the projected value. A `@nifrajs/schema` schema validates it without the
 * undeclared-key check of each closed object projection reached, which projection already did. A
 * non-enumerable property is no key to either: JSON and `structuredClone` skip it and server
 * component props refuse it, so it never reaches the browser. The one such property `JSON.stringify`
 * does read, an own `toJSON` (or an array subclass's), never survives projection.
 */
import type { StandardResult, StandardSchemaV1 } from "@nifrajs/core/server"
import { markDeferredFree } from "./deferred-free.ts"
import { wireDate } from "./wire-date.ts"

// Registry symbols shared with core and `@nifrajs/schema`, so two copies of either still agree.
const RESPONSE_RESULT = Symbol.for("nifra.response.result")
const STATUS_SIGNAL = Symbol.for("nifra.web.status-signal")
/** Set by `t.deferred(inner)` on its schema node: `inner`'s own validate. */
const DEFERRED_VALIDATE = Symbol.for("nifra.schema.deferredValidate")
/** On a `@nifrajs/schema` validate: its variant for a value projected by its own JSON Schema. */
const VALIDATE_PROJECTED = Symbol.for("nifra.schema.validateProjected")

export const DECLASSIFIED_KEY = "x-nifra-declassified"
const DEFERRED_KEY = "x-nifra-deferred"
const DATE_KEY = "x-nifra-date"

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
  /** Dev only: name the keys the guard dropped, so a schema missing a field is not a silent blank. */
  readonly warnDropped: boolean
  /** No value this guard passes can hold a `defer()` marker (see internal/deferred-free.ts). */
  readonly deferredFree: boolean
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

// Read once per schema at route load, never per request.
const inDevelopment = (): boolean =>
  typeof process !== "undefined" && process.env?.NODE_ENV === "development"

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

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/
// An invalid Date stays as it is, so the schema's own check refuses it by path.
const toWireDate = (value: Date): unknown =>
  Number.isNaN(value.getTime()) ? value : wireDate(value.getTime())

/** A `t.date()` field: a `Date` or an ISO 8601 string becomes a tagged `Date` the browser rebuilds. */
const DATE: Project = (value) =>
  value instanceof Date
    ? toWireDate(value)
    : typeof value === "string" && ISO_DATE.test(value)
      ? toWireDate(new Date(value))
      : value

/** An array whose items are all scalars, passed through whole. */
const LEAF_ARRAY: Project = (value) => (Array.isArray(value) ? plainArray(value) : value)

const typesOf = (node: Node): readonly unknown[] | undefined =>
  Array.isArray(node.type) ? node.type : node.type === undefined ? undefined : [node.type]

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const

/** What a schema node (with no `$ref` or combinator) projects as. */
function shapeOf(
  node: Node,
): "deferred" | "date" | "object" | "array" | "both" | "leaf" | "unknown" {
  if (node[DEFERRED_KEY] === true) return "deferred"
  if (node[DATE_KEY] === true) return "date"
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
  /** Some node may pass a `defer()` marker on: a deferred node, or one that lets any value through. */
  mayPassMarker = false
  private readonly memo = new Map<Node, Project>()
  private readonly issueFree = new WeakSet<Project>([LEAF, LEAF_ARRAY, DATE])
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
      case "date":
        return DATE
      case "both":
        return this.dispatch(this.object(node, where), this.array(node, where), undefined)
      case "object":
        return this.object(node, where)
      case "array":
        return this.array(node, where)
      case "leaf":
        // `not` (or an object `const`) without a `type` can accept an object.
        if (node.type === undefined) this.mayPassMarker = true
        return LEAF
      default:
        return this.unknown()
    }
  }

  private unknown(): Project {
    this.mayPassMarker = true
    return UNKNOWN
  }

  private extra(schema: unknown, where: string): Project | undefined {
    if (schema === true || (isNode(schema) && Object.keys(schema).length === 0))
      return this.unknown()
    return isNode(schema) ? this.compile(schema, `${where}/*`) : undefined
  }

  private object(node: Node, where: string): Project {
    const declared: Record<string, Project> = Object.create(null)
    for (const [key, sub] of Object.entries(isNode(node.properties) ? node.properties : {})) {
      if (!isNode(sub)) continue
      if (isSensitiveFieldName(key) && typeof sub[DECLASSIFIED_KEY] !== "string") {
        this.sensitive.push(`${where}/${key}`)
      }
      declared[key] = this.compile(sub, `${where}/${key}`)
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
    const checksMarker = open || declared.__nifra_deferred !== undefined
    const closure: Project = (value, state) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value
      if (checksMarker && isDeferred(value)) {
        state.issues.push("")
        return value
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        return value instanceof Date ? value.toJSON() : closure(snapshotOf(value), state)
      }
      const input = value as Record<string, unknown>
      // Copy-on-write: a value that already holds only declared keys is returned as it is.
      let out: Record<string, unknown> | undefined
      for (const key in input) {
        // An inherited enumerable key (a polluted prototype) is never data.
        if (!Object.hasOwn(input, key)) continue
        const projector = declared[key] ?? (open ? undeclared(key) : undefined)
        if (projector === undefined) {
          out ??= copyBefore(input, key)
          continue
        }
        const before = input[key]
        if (
          projector === LEAF_ARRAY
            ? !hasJsonHook(before)
            : projector === LEAF && !(before instanceof Date)
        ) {
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
      return out ?? (input.toJSON === undefined ? value : snapshotOf(input))
    }
    const project =
      generatedObject(declared, open ? undeclared : undefined, checksMarker) ?? closure
    if (!checksMarker && Object.values(declared).every((child) => this.issueFree.has(child)))
      this.issueFree.add(project)
    return project
  }

  private array(node: Node, where: string): Project {
    const prefixNodes = Array.isArray(node.prefixItems)
      ? node.prefixItems
      : Array.isArray(node.items)
        ? node.items
        : []
    const head = prefixNodes.map((sub, i) =>
      isNode(sub) ? this.compile(sub, `${where}/${i}`) : this.unknown(),
    )
    const restSchema = Array.isArray(node.items) ? node.additionalItems : node.items
    const rest = this.extra(restSchema, where) ?? this.unknown()
    // An array of scalars is the validator's alone: no key to drop, and walking it here would cost
    // every `string[]` a loop. A `Date` inside one reaches the validator as it is.
    if (rest === LEAF && head.every((projector) => projector === LEAF)) return LEAF_ARRAY
    // A uniform subtree that cannot emit deferred-marker issues needs no per-item path bookkeeping.
    if (head.length === 0 && this.issueFree.has(rest)) {
      const project: Project = (value, state) => {
        if (!Array.isArray(value)) return value
        let out: unknown[] | undefined
        for (let i = 0; i < value.length; i++) {
          const before = value[i]
          const after = rest(before, state)
          if (out !== undefined) out[i] = after
          else if (after !== before) {
            out = value.slice(0, i)
            out[i] = after
          }
        }
        return plainArray(out ?? value)
      }
      this.issueFree.add(project)
      return project
    }
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
      return plainArray(out ?? value)
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
    if (kinds.includes("unknown")) return this.unknown()
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
      // A union's string branch makes an ISO string ambiguous, so only a Date becomes a date here.
      kinds.includes("date"),
    )
  }

  private dispatch(
    object: Project | undefined,
    array: Project | undefined,
    deferred: Project | undefined,
    date = false,
  ): Project {
    return (value, state) => {
      if (typeof value !== "object" || value === null) return value
      if (value instanceof Date) return date ? toWireDate(value) : value.toJSON()
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
    this.mayPassMarker = true
    const validate = (node as { readonly [DEFERRED_VALIDATE]?: unknown })[DEFERRED_VALIDATE]
    if (!isNode(node.inner) || typeof validate !== "function") {
      throw new OutputGuardError(
        `the deferred value at ${where || "/"} has no inner schema; declare it with t.deferred(schema)`,
      )
    }
    const inner: CompiledGuard = {
      project: this.compile(node.inner, where),
      validate: validatorFor(validate as CompiledGuard["validate"], node.inner),
      warnDropped: inDevelopment(),
      deferredFree: false,
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

/**
 * A class instance as a plain object of its own fields, so no prototype `toJSON` or getter decides
 * what is serialized.
 */
function snapshotOf(value: object): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  for (const key of Object.keys(value))
    assign(snapshot, key, (value as Record<string, unknown>)[key])
  return snapshot
}

/** Whether `JSON.stringify` would call a `toJSON` of `value`'s own or of its prototype chain. */
const hasJsonHook = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: reads one optional property of a value already narrowed to a non-null object.
  (value as { readonly toJSON?: unknown }).toJSON !== undefined

/**
 * `value`, or a plain copy of its items when `JSON.stringify` would serialize it by a hook instead:
 * an own `toJSON`, enumerable or not, or one on a subclass prototype (which `slice` also keeps).
 */
function plainArray(value: unknown[]): unknown[] {
  if (!hasJsonHook(value)) return value
  const copy = new Array<unknown>(value.length)
  for (let i = 0; i < value.length; i++) copy[i] = value[i]
  return copy
}

// Inside `for-in`, V8 folds `hasOwnProperty.call` into the loop but calls `Object.hasOwn` per key.
// Bun runs both alike.
const ownKey = Object.prototype.hasOwnProperty
// Bun's string `switch` stops beating the dictionary lookup near 128 declared keys; V8's does not.
const MAX_GENERATED_KEYS = 64

/**
 * The object projector as code generated for its declared keys: a `switch` on each key, with every
 * key's projector a call site of its own. It reads, keeps and drops exactly what the closure in
 * `Compiler.object` does, which serves where code generation is off: an edge bundle (the build
 * defines `__NIFRA_EDGE_RUNTIME__`), a browser page (where even a caught attempt is a reported CSP
 * violation), or a runtime that refuses it. Only `JSON.stringify`d key names reach the source.
 */
function generatedObject(
  declared: Record<string, Project>,
  undeclared: ((key: string) => Project | undefined) | undefined,
  checksMarker: boolean,
): Project | undefined {
  const keys = Object.keys(declared)
  // The edge build defines this global as `true`, so that bundle drops the generator.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: only nifra's build defines this global, as a boolean literal.
  const edge = (globalThis as { readonly __NIFRA_EDGE_RUNTIME__?: boolean }).__NIFRA_EDGE_RUNTIME__
  if (keys.length > MAX_GENERATED_KEYS || edge === true || "document" in globalThis)
    return undefined
  const tail = (store: (value: string) => string, call: string): string =>
    `const from = state.issues.length; const after = ${call}(before, state);` +
    "if (state.issues.length > from) prefix(state, from, key);" +
    `if (out !== undefined) ${store("after")};` +
    `else if (after !== before) { out = copyBefore(value, key); ${store("after")}; }` +
    "continue;"
  let cases = ""
  for (const [i, key] of keys.entries()) {
    const projector = declared[key]
    const store = (value: string): string =>
      key === "__proto__" ? `assign(out, key, ${value})` : `out[${JSON.stringify(key)}] = ${value}`
    cases += `case ${JSON.stringify(key)}: { const before = value[key];`
    if (projector === LEAF_ARRAY) {
      cases += `if (!hasJsonHook(before)) { if (out !== undefined) ${store("before")}; continue; }`
    } else if (projector === LEAF) {
      cases += `if (!(before instanceof Date)) { if (out !== undefined) ${store("before")}; continue; }`
    }
    cases += `${tail(store, `p[${i}]`)} }`
  }
  const generic = (value: string): string => `assign(out, key, ${value})`
  const rest =
    undeclared === undefined
      ? "out ??= copyBefore(value, key); continue;"
      : "const projector = undeclared(key);" +
        "if (projector === undefined) { out ??= copyBefore(value, key); continue; }" +
        "const before = value[key];" +
        "if (projector === LEAF_ARRAY ? !hasJsonHook(before) : projector === LEAF && !(before instanceof Date)) {" +
        `if (out !== undefined) ${generic("before")}; continue; }` +
        tail(generic, "projector")
  const source =
    '"use strict"; return function project(value, state) {' +
    'if (typeof value !== "object" || value === null || Array.isArray(value)) return value;' +
    (checksMarker ? 'if (isDeferred(value)) { state.issues.push(""); return value; }' : "") +
    "const proto = Object.getPrototypeOf(value);" +
    "if (proto !== Object.prototype && proto !== null)" +
    "return value instanceof Date ? value.toJSON() : project(snapshotOf(value), state);" +
    "let out;" +
    "for (const key in value) {" +
    "if (!ownKey.call(value, key)) continue;" +
    `switch (key) { ${cases} default: { ${rest} } }` +
    "}" +
    "return out ?? (value.toJSON === undefined ? value : snapshotOf(value)); }"
  try {
    return new Function(
      "p",
      "undeclared",
      "isDeferred",
      "snapshotOf",
      "copyBefore",
      "assign",
      "prefix",
      "ownKey",
      "hasJsonHook",
      "LEAF",
      "LEAF_ARRAY",
      source,
    )(
      keys.map((key) => declared[key]),
      undeclared,
      isDeferred,
      snapshotOf,
      copyBefore,
      assign,
      prefix,
      ownKey,
      hasJsonHook,
      LEAF,
      LEAF_ARRAY,
    )
  } catch {
    return undefined
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
export function jsonSchemaOf(schema: StandardSchemaV1): Node | undefined {
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

/**
 * `validate`, or the variant its schema offers for a value projected by `json`: one that skips the
 * undeclared-key check of each closed object the projection already kept to its declared keys.
 */
function validatorFor(validate: CompiledGuard["validate"], json: Node): CompiledGuard["validate"] {
  const variant: unknown = Reflect.get(validate, VALIDATE_PROJECTED)
  const projected: unknown = typeof variant === "function" ? variant(json) : undefined
  return isValidate(projected) ? projected : validate
}

const isValidate = (value: unknown): value is CompiledGuard["validate"] =>
  typeof value === "function"

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
  let deferredFree = false
  if (json !== undefined) {
    const compiler = new Compiler(json)
    project = compiler.compile(json, "")
    deferredFree = !compiler.mayPassMarker
    if (compiler.sensitive.length > 0) {
      throw new OutputGuardError(
        `${owner} declares sensitive field(s) ${compiler.sensitive.join(", ")} in ${exportName}. Remove them, or mark a field that must reach the browser with t.declassified("why it may", schema)`,
        compiler.sensitive,
      )
    }
  }
  const guard: CompiledGuard = {
    project,
    validate:
      json === undefined
        ? standard["~standard"].validate
        : validatorFor(standard["~standard"].validate, json),
    warnDropped: inDevelopment(),
    deferredFree,
  }
  compiled.set(schema, guard)
  return guard
}

/** Where `before` held a key `after` lacks. Array indices collapse to `*`, so one field reads once. */
function droppedPaths(before: unknown, after: unknown, path: string, out: Set<string>): void {
  if (before === after || typeof before !== "object" || before === null) return
  if (typeof after !== "object" || after === null || before instanceof Date) return
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return
    const length = Math.min(before.length, after.length)
    for (let i = 0; i < length; i++) droppedPaths(before[i], after[i], `${path}/*`, out)
    return
  }
  const kept: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(after))
  for (const [key, value] of Object.entries(before)) {
    // JSON drops an undefined value anyway; the guard dropping it changes nothing the page sees.
    if (value === undefined) continue
    if (!Object.hasOwn(kept, key)) out.add(`${path}/${key}`)
    else droppedPaths(value, kept[key], `${path}/${key}`, out)
  }
}

const warnedDrops = new Set<string>()

function warnDropped(label: string, before: unknown, after: unknown): void {
  const found = new Set<string>()
  droppedPaths(before, after, "", found)
  if (found.size === 0) return
  const paths = [...found]
  const key = `${label}\n${paths.join("\n")}`
  if (warnedDrops.has(key)) return
  if (warnedDrops.size >= 1000) warnedDrops.clear()
  warnedDrops.add(key)
  const shown = paths.slice(0, 10).join(", ")
  const more = paths.length > 10 ? ` and ${paths.length - 10} more` : ""
  console.warn(
    `[nifra/web] ${label} returned field(s) its output schema does not declare, so they were dropped before the browser: ${shown}${more}. Declare a field in the schema if the page needs it. (Shown in development only.)`,
  )
}

const pathOf = (issue: { readonly path?: ReadonlyArray<unknown> | undefined }): string =>
  (issue.path ?? [])
    .map(
      (segment) =>
        `/${String(typeof segment === "object" && segment !== null ? (segment as { key: unknown }).key : segment)}`,
    )
    .join("") || "/"

function settle(
  guard: CompiledGuard,
  result: StandardResult<unknown>,
  label: string,
  input: unknown,
): unknown {
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
    // No JSON Schema to project by: the schema's own validate stripped what it does not declare.
    if (guard.warnDropped) warnDropped(label, input, result.value)
  }
  // Only the projected value itself: a validator that returns a new value (a transform) may add a marker.
  if (guard.deferredFree && result.value === input) markDeferredFree(result.value)
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
    // Copy-on-write: the same reference back means nothing was dropped anywhere below.
    if (guard.warnDropped && projected !== value) warnDropped(label, value, projected)
  }
  const result = guard.validate(projected)
  return result instanceof Promise
    ? result.then((settled) => settle(guard, settled, label, projected))
    : settle(guard, result, label, projected)
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

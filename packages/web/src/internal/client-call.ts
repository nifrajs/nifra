/**
 * How a route is printed for an AI agent, by `nifra context` and by a served `llms.txt`: its JSON Schema
 * shapes as compact TypeScript, and the exact `client<typeof app>` call that reaches it.
 */
import { compileRoutePattern, type RoutePatternSegment } from "@nifrajs/core/pattern"

/** The subset of JSON Schema fields {@link tsTypeOf} reads. */
interface JsonSchemaNode {
  readonly type?: unknown
  readonly anyOf?: unknown
  readonly oneOf?: unknown
  readonly enum?: unknown
  readonly const?: unknown
  readonly items?: unknown
  readonly properties?: Readonly<Record<string, unknown>>
  readonly required?: unknown
  readonly additionalProperties?: unknown
}

/**
 * Render a JSON Schema as a compact TypeScript-like type (`{ id: string, name?: string }`) - the
 * shape agents already think in, at a fraction of the raw JSON Schema's tokens (~70-80% smaller).
 * Anything the renderer doesn't model falls back to the raw JSON for that subtree, so the output
 * is always faithful, just not always minimal.
 */
export function tsTypeOf(schema: unknown, depth = 0): string {
  if (typeof schema !== "object" || schema === null || depth > 6) return JSON.stringify(schema)
  const node: JsonSchemaNode = schema
  const union = node.anyOf ?? node.oneOf
  if (Array.isArray(union)) return union.map((u) => tsTypeOf(u, depth + 1)).join(" | ")
  if (Array.isArray(node.enum)) return node.enum.map((v) => JSON.stringify(v)).join(" | ")
  if (node.const !== undefined) return JSON.stringify(node.const)
  switch (node.type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array": {
      const item = tsTypeOf(node.items, depth + 1)
      // Parenthesize unions so `(A | B)[]` reads as the array it is.
      return item.includes(" | ") ? `(${item})[]` : `${item}[]`
    }
    case "object": {
      const props = node.properties
      if (props === undefined) {
        return node.additionalProperties === undefined || node.additionalProperties === false
          ? "{}"
          : `Record<string, ${node.additionalProperties === true ? "unknown" : tsTypeOf(node.additionalProperties, depth + 1)}>`
      }
      const required = new Set<unknown>(Array.isArray(node.required) ? node.required : [])
      const fields = Object.entries(props).map(
        ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${tsTypeOf(value, depth + 1)}`,
      )
      return `{ ${fields.join(", ")} }`
    }
    default:
      return JSON.stringify(schema)
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// The typed client's reserved proxy keys, a frozen list in @nifrajs/client's reserved.ts: verbs are
// intercepted in any casing, these exactly, and every key added since is `$`-prefixed.
const RESERVED_VERBS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
])
const RESERVED_EXACT: ReadonlySet<string> = new Set(["subscribe", "ws", "index", "then"])

const isReservedKey = (segment: string): boolean =>
  RESERVED_VERBS.has(segment.toLowerCase()) ||
  RESERVED_EXACT.has(segment) ||
  segment.startsWith("$")

/** The typed client's terminal call for an HTTP method, or `undefined` when it has none. */
export function typedClientKey(method: string): string | undefined {
  const verb = method.toLowerCase()
  if (verb === "query") return "$query"
  return RESERVED_VERBS.has(verb) ? verb : undefined
}

/**
 * The call a non-static segment adds to the chain, or `undefined` for a static one. The segment is
 * read by the router's own grammar, so the spelling matches what the typed client accepts:
 *   - a whole param or a wildcard is called by its name - `:id` and `:id{[0-9]+}` are `({ id })`;
 *   - a segment that is part literal, part parameter is called with the segment text -
 *     `:name.json` is ``(`${name}.json`)``.
 */
function paramCall(seg: string): string | undefined {
  let segment: RoutePatternSegment | undefined
  try {
    segment = compileRoutePattern(`/${seg}`).segments[0]
  } catch {
    return undefined
  }
  if (segment === undefined || segment.kind === "static") return undefined
  if (segment.kind === "param") return `({ ${segment.name} })`
  if (segment.kind === "wildcard") {
    return segment.name === "*" ? '({ "*": rest })' : `({ ${segment.name} })`
  }
  const [only] = segment.parts
  if (segment.parts.length === 1 && only?.t === "param") return `({ ${only.name} })`
  const text = segment.parts
    .map((part) => (part.t === "lit" ? part.v.replace(/[`\\]|\$\{/g, "\\$&") : `\${${part.name}}`))
    .join("")
  return `(\`${text}\`)`
}

/**
 * The typed-client proxy chain for a path, without the terminal verb call. A segment spelling a
 * reserved proxy key (`delete`, `subscribe`, `then`, `$query`, ...) is a call on the parent node, and
 * not bracket access, which does not help: the proxy intercepts the key however it is spelled.
 */
export function clientChain(path: string): string {
  const segs = path.split("/").filter((seg) => seg !== "")
  if (segs.length === 0) return "api.index"
  let chain = "api"
  for (const seg of segs) {
    const call = paramCall(seg)
    if (call !== undefined) chain += call
    else if (isReservedKey(seg)) chain += `(${JSON.stringify(seg)})`
    else chain += IDENT.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`
  }
  return chain
}

/**
 * The typed-client call form for a route - the exact `client<typeof app>` proxy chain an agent should
 * write: a static segment is a property (`.users`), a path param/wildcard is a call that appends the
 * value (`({ id })`), the root path is `.index`, and the method is the terminal call. POST, PUT, PATCH
 * and QUERY (`.$query`) take the body first, then the call options; DELETE takes its body inside the
 * options; the rest take only the options. A WebSocket route (the pseudo-method `WS`) is a `.ws()`
 * that returns its handle at once, so it is not awaited. A method the typed client has no call for goes
 * out through `fetch`, against the route's own path.
 */
export function clientCall(
  method: string,
  path: string,
  schema: { readonly body?: unknown; readonly query?: unknown } | undefined,
): string {
  if (method === "WS") return `${clientChain(path)}.ws()`
  const key = typedClientKey(method)
  if (key === undefined) return `await fetch(url, { method: ${JSON.stringify(method)} })`
  let args: string
  if (key === "post" || key === "put" || key === "patch" || key === "$query") {
    // A route with a query but no body must still fill the body slot.
    const bodyArg = schema?.body ? "body" : schema?.query ? "undefined" : ""
    const opts = schema?.query ? (bodyArg ? ", { query }" : "{ query }") : ""
    args = bodyArg + opts
  } else if (key === "delete") {
    const fields: string[] = []
    if (schema?.body) fields.push("body")
    if (schema?.query) fields.push("query")
    args = fields.length === 0 ? "" : `{ ${fields.join(", ")} }`
  } else {
    args = schema?.query ? "{ query }" : ""
  }
  return `await ${clientChain(path)}.${key}(${args})`
}

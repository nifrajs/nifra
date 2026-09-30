/**
 * Request bodies in a media type of your own - `bodyParser(schema, { types, parse })`.
 *
 * A route reads JSON and urlencoded bodies by default and answers `415` to everything else. Wrapping
 * its body schema names the other media types that one route reads and the function that decodes
 * them. The decoded value is then validated by the schema like any other body.
 *
 *   import { bodyParser } from "@nifrajs/core/body-parser"
 *   import { parse } from "yaml"
 *
 *   const utf8 = new TextDecoder("utf-8", { fatal: true })
 *
 *   app.post(
 *     "/pipelines",
 *     {
 *       body: bodyParser(Pipeline, {
 *         types: ["application/yaml"],
 *         parse: (bytes) => parse(utf8.decode(bytes), { maxAliasCount: 0 }),
 *       }),
 *     },
 *     (c) => c.body.name,
 *   )
 *
 * What is settled before `parse` runs:
 * - the request's media type is one of `types`: compared whole, case folded, parameters set aside
 * - the body is at most the route's `bodyLimit`, measured on the bytes delivered and not on the
 *   header, and it is fully read: `parse` is handed bytes and never the request
 *
 * What is settled before the schema runs:
 * - a `parse` that throws or rejects answers `400 invalid_body`
 * - the value is a tree. An array or object reached twice is what an alias or a cycle decodes to,
 *   and walking it can cost far more than the bytes that described it, so it answers `400`
 * - the app's prototype-poisoning policy: a `__proto__` key, a `constructor` that carries a
 *   `prototype`, and an object whose prototype was replaced by decoded data
 *
 * What it does not: a parser's own limits. Nesting depth, alias expansion, and number or string
 * sizes belong to the decoder you pass, so configure it for untrusted input.
 *
 * `types` cannot name a media type that already has a reader (JSON, urlencoded, multipart) or
 * `text/plain`. A browser sends `text/plain` from any site with the user's cookies and no preflight,
 * so a route that parsed it would be reachable by a form no CORS policy ever saw. Read such a body
 * in the handler with `c.boundedBody`, behind an explicit origin check.
 */
import type { StandardSchemaV1 } from "../schema/standard.ts"
import { readBoundedBytes } from "./body.ts"
import { SCHEMA_BODY_READER, type SchemaBodyReader } from "./body-lane.ts"
import { plainError } from "./http.ts"
import type { ProtoPoisoning } from "./proto-guard.ts"
import { isJsonMediaType } from "./query.ts"

/** What `parse` is told about the body it is decoding. */
export interface BodyParserInput {
  /** The media type that matched, lower-cased and without parameters. */
  readonly mediaType: string
  /** The request's `content-type` as sent, for a parser that reads a parameter such as `charset`. */
  readonly contentType: string
}

export interface BodyParserOptions {
  /** The media types this parser reads, each a full `type/subtype` with no parameters or wildcard. */
  readonly types: readonly string[]
  /** Decode the body. The result is what the schema validates; throw to refuse the body with `400`. */
  readonly parse: (bytes: Uint8Array, input: BodyParserInput) => unknown
}

// RFC 6838 `restricted-name "/" restricted-name`, lower-cased.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/

const REFUSED = new Error("invalid_body")

function mediaTypesOf(types: readonly string[]): readonly string[] {
  if (!Array.isArray(types) || types.length === 0) {
    throw new TypeError("bodyParser: types must name at least one media type")
  }
  const seen = new Set<string>()
  for (const value of types as readonly unknown[]) {
    if (typeof value !== "string") throw new TypeError("bodyParser: a media type must be a string")
    const type = value.toLowerCase()
    if (!MEDIA_TYPE.test(type)) {
      throw new TypeError(
        `bodyParser: "${value}" is not a media type. Name it in full, such as "application/yaml", with no parameters and no wildcard`,
      )
    }
    if (isJsonMediaType(type)) {
      throw new TypeError(`bodyParser: "${value}" is JSON, which every body schema already reads`)
    }
    if (type === "application/x-www-form-urlencoded") {
      throw new TypeError(`bodyParser: "${value}" is a form, which every body schema already reads`)
    }
    if (type.startsWith("multipart/")) {
      throw new TypeError(
        `bodyParser: "${value}" is a multipart body. Use multipartBody from "@nifrajs/core/multipart"`,
      )
    }
    if (type === "text/plain") {
      throw new TypeError(
        `bodyParser: "${value}" is sent by a browser from any site without a preflight. Read it in the handler with c.boundedBody, behind an origin check`,
      )
    }
    seen.add(type)
  }
  return Object.freeze([...seen])
}

/** Whether `proto` is the prototype of a class, as opposed to an object decoded from the body. */
function isClassPrototype(proto: object): boolean {
  const own = Object.getOwnPropertyDescriptor(proto, "constructor")?.value as unknown
  return typeof own === "function" && (own as { prototype?: unknown }).prototype === proto
}

/**
 * One pass over a decoded value. It throws for a value that is not a tree, and applies the
 * prototype-poisoning policy to every plain object in it. Iterative, so nesting cannot exhaust the
 * call stack, and each node is visited once, so the cost is the size of what the parser built.
 */
function settle(root: unknown, policy: ProtoPoisoning): void {
  const seen = new Set<object>()
  const stack: object[] = []
  const push = (value: unknown): void => {
    if (value === null || typeof value !== "object") return
    if (!Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set)) {
      const proto = Object.getPrototypeOf(value) as object | null
      if (proto !== null && proto !== Object.prototype) {
        if (!isClassPrototype(proto)) {
          // A plain object whose prototype is now data: a decoder that assigns keys one by one
          // turns a `__proto__` key into exactly this, and every property of that data then reads
          // as the object's own.
          if (policy === "reject") throw REFUSED
          if (policy === "strip") Object.setPrototypeOf(value, Object.prototype)
        } else if (Object.getPrototypeOf(proto) !== null) {
          // An instance of a class (a Date, a typed array) is a leaf: it has no keys a body chose.
          return
        }
        // A class prototype with nothing above it is the `Object.prototype` of another realm, and
        // the object is as plain as one made here.
      }
    }
    if (seen.has(value)) throw REFUSED
    seen.add(value)
    stack.push(value)
  }

  push(root)
  while (stack.length > 0) {
    const node = stack.pop() as object
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) push(node[i])
      continue
    }
    if (node instanceof Map) {
      for (const [key, value] of node) {
        push(key)
        push(value)
      }
      continue
    }
    if (node instanceof Set) {
      for (const value of node) push(value)
      continue
    }
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const value = record[key]
      if (policy !== "ignore") {
        const poisoned =
          key === "__proto__" ||
          (key === "constructor" &&
            value !== null &&
            typeof value === "object" &&
            Object.hasOwn(value, "prototype"))
        if (poisoned) {
          if (policy === "reject") throw REFUSED
          delete record[key]
          continue
        }
      }
      push(value)
    }
  }
}

/**
 * Opt a route's body schema into media types of your own. Returns a copy of `schema` that also reads
 * a body whose media type is one of `types`, decoded by `parse`; the schema itself is not changed,
 * and JSON and urlencoded bodies still reach it. A schema that already reads another type, such as a
 * form, keeps reading it.
 *
 * Throws a `TypeError` for a `types` entry that is not a full media type, or that names JSON,
 * urlencoded, multipart, or `text/plain`.
 */
export function bodyParser<Schema extends StandardSchemaV1>(
  schema: Schema,
  options: BodyParserOptions,
): Schema {
  const types = mediaTypesOf(options.types)
  const parse = options.parse
  if (typeof parse !== "function") throw new TypeError("bodyParser: parse must be a function")
  const accepts = new Set(types)
  const carried = (schema as { readonly [SCHEMA_BODY_READER]?: SchemaBodyReader })[
    SCHEMA_BODY_READER
  ]
  const inner = typeof carried === "function" ? carried : undefined

  const read: SchemaBodyReader = async (source, contentType, maxBodyBytes, protoPoisoning) => {
    const semi = contentType.indexOf(";")
    const mediaType = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
    if (!accepts.has(mediaType)) {
      return inner === undefined
        ? plainError(415, "unsupported_media_type")
        : inner(source, contentType, maxBodyBytes, protoPoisoning)
    }
    const body = await readBoundedBytes(source, maxBodyBytes)
    if (!body.ok) {
      return body.status === 413
        ? plainError(413, "payload_too_large")
        : plainError(400, "invalid_content_length")
    }
    try {
      const value = await parse(body.bytes, { mediaType, contentType })
      settle(value, protoPoisoning)
      return value
    } catch {
      return plainError(400, "invalid_body")
    }
  }
  const mediaTypes = Object.freeze([...new Set([...types, ...(inner?.mediaTypes ?? [])])])
  const reader: PropertyDescriptor = {
    value: Object.defineProperty(read, "mediaTypes", { value: mediaTypes }),
  }

  if (typeof schema === "function") {
    // A callable schema cannot be copied; an object that delegates to it reads the same.
    return Object.defineProperty(Object.create(schema), SCHEMA_BODY_READER, reader) as Schema
  }
  // The reader goes in with the copied properties rather than after them: a schema that was already
  // opted in carries a reader that cannot be redefined.
  return Object.create(Object.getPrototypeOf(schema), {
    ...Object.getOwnPropertyDescriptors(schema),
    [SCHEMA_BODY_READER]: reader,
  }) as Schema
}

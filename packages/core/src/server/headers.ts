/** Materialize request headers for a Standard Schema boundary.
 *
 * HTTP field names are case-insensitive and `Headers` already combines repeated fields using the
 * platform's defined comma-join behavior. A null-prototype record prevents a hostile field name
 * such as `__proto__` or `constructor` from interacting with Object.prototype before validation.
 */
export function headerObjectOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [name, value] of headers) out[name.toLowerCase()] = value
  return out
}

const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/

/** The parts of a header schema's JSON Schema that decide how the slot reads the request. */
interface HeaderJsonSchema {
  readonly type?: unknown
  readonly additionalProperties?: unknown
  readonly patternProperties?: unknown
  readonly properties?: object
}

/**
 * The names a closed header schema declares, or `undefined` when it is open or lists no names.
 * Every client sends headers no route declares (`host`, `user-agent`, `accept`), so a closed schema
 * fed the whole record would refuse all real traffic; it is fed the names it declares instead,
 * which is also how OpenAPI publishes it. A name that is not a valid header token is never sent.
 */
export function declaredHeaderNames(schema: object): readonly string[] | undefined {
  const json: HeaderJsonSchema | null | undefined = Reflect.get(schema, "jsonSchema")
  return json?.type === "object" &&
    json.additionalProperties === false &&
    json.patternProperties === undefined &&
    json.properties
    ? Object.keys(json.properties).filter((name) => HEADER_NAME.test(name))
    : undefined
}

/** The declared headers present on the request, each under the name as declared. */
export function declaredHeaders(
  headers: Headers,
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const name of names) {
    const value = headers.get(name)
    if (value !== null) out[name] = value
  }
  return out
}

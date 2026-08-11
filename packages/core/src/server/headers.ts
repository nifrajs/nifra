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

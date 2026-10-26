/**
 * The query string every client transport sends: an array repeats its key once per item, an
 * `undefined` value is left out and a `Date` is written as the RFC 3339 string `t.date()` reads, so a
 * WebSocket handshake reads the same as an HTTP call.
 */
export function buildQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, text(item))
    } else {
      params.set(key, text(value))
    }
  }
  return params.toString()
}

const text = (value: unknown): string =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : String(value)

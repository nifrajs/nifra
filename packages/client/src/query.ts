/**
 * The query string every client transport sends: an array repeats its key once per item and an
 * `undefined` value is left out, so a WebSocket handshake reads the same as an HTTP call.
 */
export function buildQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.set(key, String(value))
    }
  }
  return params.toString()
}

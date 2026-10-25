const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "CONNECT",
  "TRACE",
  "QUERY",
])

/** A method as a label or span name may carry it. Any other method a runtime accepts (Deno takes
 * extension tokens) is `_OTHER`, as OpenTelemetry's HTTP conventions name it, so a client cannot
 * mint a new series or span name per request. */
export function methodLabel(method: string): string {
  return KNOWN_METHODS.has(method) ? method : "_OTHER"
}

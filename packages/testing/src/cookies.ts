/**
 * A tiny cookie jar for in-process tests — parses `Set-Cookie` off responses and emits a `Cookie`
 * request header, so a login → authenticated-request flow works without threading headers by hand. It
 * honours removal (`Max-Age=0` / a past `Expires`) so logout clears the cookie; other attributes
 * (Domain/Path/Secure/SameSite) are ignored — everything is same-origin in-process.
 */

export interface CookieJar {
  /** The current `Cookie` request-header value (`"a=1; b=2"`, or `""` when empty). */
  header(): string
  /** Set the `Cookie` header on `headers` when the jar is non-empty. */
  applyTo(headers: Headers): void
  /** Absorb every `Set-Cookie` on a response (setting or, on removal, deleting each). */
  store(response: { headers: Headers }): void
  set(name: string, value: string): void
  get(name: string): string | undefined
  clear(): void
  readonly size: number
}

/** Read `Set-Cookie` values portably: `getSetCookie()` (Bun/Node/edge) with a single-header fallback. */
function setCookies(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetter.getSetCookie === "function") return withGetter.getSetCookie()
  const single = headers.get("set-cookie")
  return single === null ? [] : [single]
}

function isRemoval(attributes: string): boolean {
  if (/(^|;)\s*max-age=0(\s|;|$)/.test(attributes)) return true
  const expires = /expires=([^;]+)/.exec(attributes)
  if (expires === null) return false
  const at = Date.parse(expires[1] as string)
  return !Number.isNaN(at) && at < Date.now()
}

function parseSetCookie(line: string): { name: string; value: string; remove: boolean } | null {
  const semicolon = line.indexOf(";")
  const pair = semicolon === -1 ? line : line.slice(0, semicolon)
  const equals = pair.indexOf("=")
  if (equals === -1) return null
  const name = pair.slice(0, equals).trim()
  if (name === "") return null
  const value = pair.slice(equals + 1).trim()
  const attributes = semicolon === -1 ? "" : line.slice(semicolon + 1).toLowerCase()
  return { name, value, remove: isRemoval(attributes) }
}

/** Create an empty cookie jar. */
export function cookieJar(): CookieJar {
  const cookies = new Map<string, string>()
  const header = (): string => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  return {
    header,
    get size() {
      return cookies.size
    },
    set: (name, value) => {
      cookies.set(name, value)
    },
    get: (name) => cookies.get(name),
    clear: () => cookies.clear(),
    applyTo: (headers) => {
      const current = header()
      if (current !== "") headers.set("cookie", current)
    },
    store: (response) => {
      for (const line of setCookies(response.headers)) {
        const parsed = parseSetCookie(line)
        if (parsed === null) continue
        if (parsed.remove) cookies.delete(parsed.name)
        else cookies.set(parsed.name, parsed.value)
      }
    },
  }
}

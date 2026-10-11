import type { CookieOptions } from "@nifrajs/core/server"

export interface ProgressiveCookie {
  readonly name: string
  readonly value: string
  readonly options?: CookieOptions | undefined
  readonly deleted?: boolean
}

/** Parent-domain acceptance belongs to the browser's cookie jar and public-suffix policy. A Secure
 * cookie on a request seen as `http:` does too: behind a TLS terminator only the browser knows its
 * scheme, so it decides whether the cookie is kept. */
export function progressiveCookieRedirect(
  request: Request,
  changes: readonly ProgressiveCookie[],
): boolean {
  const url = new URL(request.url)
  const host = url.hostname.toLowerCase()
  return changes.some((change) => {
    const domain = change.options?.domain?.replace(/^\./, "").toLowerCase()
    if (domain !== undefined && domain !== host && host.endsWith("." + domain)) return true
    return secureOnPlainHttp(url, change)
  })
}

const secureOnPlainHttp = (url: URL, change: ProgressiveCookie): boolean =>
  (change.options?.secure ?? !change.deleted) && url.protocol !== "https:"

/** Reauthorize the internal GET with action cookies that are valid for this exact owner URL. */
export function progressiveCookieHeader(
  request: Request,
  changes: readonly ProgressiveCookie[],
): string {
  const url = new URL(request.url)
  let pairs = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
  for (const change of changes) {
    const options = change.options
    const domain = options?.domain?.replace(/^\./, "").toLowerCase()
    // Parent-domain cookies need a browser cookie jar/public-suffix decision; never synthesize them.
    if (domain !== undefined && domain !== url.hostname.toLowerCase()) continue
    if (secureOnPlainHttp(url, change)) continue
    const path = options?.path ?? "/"
    if (
      url.pathname !== path &&
      !(url.pathname.startsWith(path) && (path.endsWith("/") || url.pathname[path.length] === "/"))
    )
      continue
    pairs = pairs.filter((pair) => pair.slice(0, pair.indexOf("=")).trim() !== change.name)
    const expired =
      options?.maxAge !== undefined
        ? options.maxAge <= 0
        : options?.expires !== undefined && options.expires.getTime() <= Date.now()
    if (!change.deleted && !expired)
      pairs.push(change.name + "=" + encodeURIComponent(change.value))
  }
  return pairs.join("; ")
}

import type { CookieOptions } from "@nifrajs/core/server"

export interface ProgressiveCookie {
  readonly name: string
  readonly value: string
  readonly options?: CookieOptions | undefined
  readonly deleted?: boolean
}

/** Parent-domain acceptance belongs to the browser's cookie jar and public-suffix policy. */
export function progressiveCookieRedirect(
  request: Request,
  changes: readonly ProgressiveCookie[],
): boolean {
  const host = new URL(request.url).hostname.toLowerCase()
  return changes.some(({ options }) => {
    const domain = options?.domain?.replace(/^\./, "").toLowerCase()
    return domain !== undefined && domain !== host && host.endsWith("." + domain)
  })
}

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
    if ((options?.secure ?? !change.deleted) && url.protocol !== "https:") continue
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

/**
 * The browser half of the detector's `persist` cookie: the string a language switcher assigns to
 * `document.cookie`, byte-identical to the `Set-Cookie` `localeDetector({ persist: true })` writes, so
 * a choice made in the page and one made through `?lang=` are the same cookie. Dependency-free.
 */

/** One year, the detector's default `cookieMaxAge`. */
export const LOCALE_COOKIE_MAX_AGE = 31_536_000

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MAX_COOKIE_BYTES = 4096

export interface LocaleCookieOptions {
  /** `Max-Age` in seconds. Default one year, matching the detector's `cookieMaxAge` default. Pass
   * the same value the detector is configured with. */
  readonly maxAge?: number
}

/**
 * The `document.cookie` string that remembers `locale` under the detector's cookie `name`:
 * `Path=/; SameSite=Lax`, a one-year `Max-Age` by default, and `Secure` for a `__Secure-`/`__Host-`
 * name. Not `HttpOnly`, like the detector's, so the switcher can write it. The value only ever
 * selects one of the app's own locales: the detector matches it against its allow-list on read.
 *
 * ```ts
 * import { localeCookie } from "@nifrajs/i18n"
 *
 * document.cookie = localeCookie("locale", "hi")
 * ```
 *
 * Throws for a name that is not an RFC 6265 token, a non-integer `maxAge`, or a cookie over 4 KB.
 */
export function localeCookie(
  name: string,
  locale: string,
  options: LocaleCookieOptions = {},
): string {
  if (!COOKIE_NAME.test(name)) {
    throw new Error(
      `[nifra/i18n] invalid cookie name ${JSON.stringify(name)}: must be an RFC 6265 token`,
    )
  }
  const maxAge = options.maxAge ?? LOCALE_COOKIE_MAX_AGE
  if (!Number.isInteger(maxAge)) {
    throw new Error("[nifra/i18n] cookie maxAge must be an integer number of seconds")
  }
  // Browsers match the prefixes case-insensitively; a prefixed name is only kept with `Secure` (and
  // `Path=/`, already set, for `__Host-`).
  const lowered = name.toLowerCase()
  const secure = lowered.startsWith("__secure-") || lowered.startsWith("__host-")
  const cookie = `${name}=${encodeURIComponent(locale)}; Max-Age=${maxAge}; Path=/${secure ? "; Secure" : ""}; SameSite=Lax`
  if (cookie.length > MAX_COOKIE_BYTES) {
    throw new Error(
      `[nifra/i18n] cookie ${JSON.stringify(name)} is ${cookie.length}B, over the ${MAX_COOKIE_BYTES}B limit`,
    )
  }
  return cookie
}

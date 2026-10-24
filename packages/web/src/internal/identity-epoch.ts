/**
 * The server half of the identity epoch: a response that signs a visitor in or out also rotates the
 * readable epoch cookie, so every tab drops the pages it kept alive for the previous visitor.
 *
 * A header-only hook reads each response's `Set-Cookie`: when an identity cookie's value differs from
 * the request's, or the cookie is deleted, the response also sets a fresh epoch with the same lifetime,
 * so the epoch expires with an idle session. A rolling session re-sending the same value with a new
 * lifetime re-sends the epoch it holds with that lifetime, so the two keep expiring together.
 */
import { type CookieOptions, parseCookies } from "@nifrajs/core/server"
import { EPOCH_COOKIE, LOCAL_EPOCH_COOKIE } from "../identity.ts"

/** `createWebApp`'s `keepAlive` option: which cookies say who is signed in. */
export interface KeepAliveServerOptions {
  /**
   * Cookies whose change means a different visitor, on top of the session cookies of
   * `@nifrajs/auth`, Better Auth and Auth.js under their default names. Name a custom session cookie
   * here, or kept pages survive a sign-in or sign-out through it.
   */
  readonly identityCookies?: readonly string[]
  /** `HttpOnly` cookies that say nothing about who is signed in; development stops asking about them. */
  readonly ignoreCookies?: readonly string[]
}

/** The request and response a header hook sees. */
interface HeaderView {
  get(name: string): string | null
  append(name: string, value: string): void
}
interface RequestView {
  readonly url: string
  header(name: string): string | null | undefined
}

// Session cookies by their default names, without a `__Secure-` / `__Host-` prefix.
const IDENTITY_DEFAULTS = [
  "nifra_session",
  "better-auth.session_token",
  "authjs.session-token",
  "next-auth.session-token",
]
// `HttpOnly` cookies the same integrations write that carry no identity of their own.
const IGNORE_DEFAULTS = [
  "better-auth.session_data",
  "better-auth.dont_remember",
  "authjs.csrf-token",
  "authjs.callback-url",
  "authjs.pkce.code_verifier",
  "authjs.state",
  "authjs.nonce",
  "next-auth.csrf-token",
  "next-auth.callback-url",
  "next-auth.pkce.code_verifier",
  "next-auth.state",
  "next-auth.nonce",
  "__nifra_draft",
]

// `__Secure-a.0` and `__Host-a` are the cookie `a`: a prefix, then Auth.js's chunk index.
const baseName = (name: string): string =>
  name.replace(/^__(?:secure|host)-/i, "").replace(/\.\d+$/, "")

interface SetCookie {
  readonly name: string
  readonly value: string
  readonly deleted: boolean
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly maxAge: string | undefined
  readonly expires: string | undefined
}

// Splits a `Set-Cookie` list joined with ", ": only a comma followed by `name=` starts a cookie, so
// the comma inside an `Expires` date stays where it is.
const SPLIT = /,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/

const parseSetCookies = (joined: string, now: number): SetCookie[] => {
  const cookies: SetCookie[] = []
  for (const line of joined.split(SPLIT)) {
    const [pair = "", ...attributes] = line.split(";")
    const at = pair.indexOf("=")
    if (at <= 0) continue
    let maxAge: string | undefined
    let expires: string | undefined
    let httpOnly = false
    let secure = false
    for (const attribute of attributes) {
      const eq = attribute.indexOf("=")
      const key = (eq === -1 ? attribute : attribute.slice(0, eq)).trim().toLowerCase()
      const value = eq === -1 ? "" : attribute.slice(eq + 1).trim()
      if (key === "max-age") maxAge = value
      else if (key === "expires") expires = value
      else if (key === "httponly") httpOnly = true
      else if (key === "secure") secure = true
    }
    const name = pair.slice(0, at).trim()
    const age = maxAge === undefined ? Number.NaN : Number(maxAge)
    const until = expires === undefined ? Number.NaN : Date.parse(expires)
    cookies.push({
      name,
      // Decoded as core decodes the request's cookies, so an encoded value compares equal to itself.
      value: parseCookies(pair.trim())[name] ?? "",
      deleted: age <= 0 || until <= now,
      httpOnly,
      secure: secure || /^__(?:secure|host)-/i.test(name),
      maxAge,
      expires,
    })
  }
  return cookies
}

const randomEpoch = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let hex = ""
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return hex
}

const EPOCH_VALUE = /^[0-9a-f]{32}$/

// A forwarded protocol only picks the cookie's name: a client that lies about it loses its own epoch.
// A browser sends a `__Host-` cookie only over https, so carrying one says so behind a TLS proxy that
// forwards nothing, and the client, which reads that one first, must see the new value there.
const servedOverHttps = (request: RequestView, sent: Readonly<Record<string, string>>): boolean => {
  if (request.url.startsWith("https:") || sent[EPOCH_COOKIE] !== undefined) return true
  const forwarded = request.header("x-forwarded-proto")
  return forwarded?.split(",")[0]?.trim().toLowerCase() === "https"
}

const epochCookie = (
  secure: boolean,
  value: string,
  lifetime: { readonly maxAge?: string | undefined; readonly expires?: string | undefined },
): string => {
  let cookie = `${secure ? EPOCH_COOKIE : LOCAL_EPOCH_COOKIE}=${value}; Path=/; SameSite=Lax`
  if (secure) cookie += "; Secure"
  if (lifetime.maxAge !== undefined) cookie += `; Max-Age=${lifetime.maxAge}`
  if (lifetime.expires !== undefined) cookie += `; Expires=${lifetime.expires}`
  return cookie
}

/**
 * The response hook `createWebApp` installs for an app with a `keepAlive` route. With `development`,
 * it also says once per cookie when an `HttpOnly` cookie it does not know changes.
 */
export function identityEpochHook(
  options: KeepAliveServerOptions,
  development: boolean,
): (headers: HeaderView, request: RequestView) => void {
  const identity = new Set([...IDENTITY_DEFAULTS, ...(options.identityCookies ?? []).map(baseName)])
  const ignored = new Set([...IGNORE_DEFAULTS, ...(options.ignoreCookies ?? []).map(baseName)])
  const reported = new Set<string>()
  return (headers, request) => {
    const joined = headers.get("set-cookie")
    if (joined === null || joined === "") return
    const sent = parseCookies(request.header("cookie") ?? null)
    let changed: SetCookie | undefined
    let renewed: SetCookie | undefined
    for (const cookie of parseSetCookies(joined, Date.now())) {
      if (cookie.name === EPOCH_COOKIE || cookie.name === LOCAL_EPOCH_COOKIE) return
      const now = cookie.deleted ? "" : cookie.value
      const base = baseName(cookie.name)
      if (now === (sent[cookie.name] ?? "")) {
        if (
          renewed === undefined &&
          !cookie.deleted &&
          (cookie.maxAge !== undefined || cookie.expires !== undefined) &&
          identity.has(base)
        )
          renewed = cookie
        continue
      }
      if (identity.has(base)) {
        // The first identity cookie still set gives the lifetime; a sign-out deletes them all.
        if (changed === undefined || (changed.deleted && !cookie.deleted)) changed = cookie
        continue
      }
      if (!development || !cookie.httpOnly || ignored.has(base) || reported.has(base)) continue
      reported.add(base)
      console.warn(
        `[nifra/web] NIFRA_KEEPALIVE_IDENTITY_COOKIE: this app keeps pages alive, and a response changed the HttpOnly cookie "${cookie.name}", which nifra does not know as a sign-in cookie. If it says who is signed in, add it to createWebApp({ keepAlive: { identityCookies: ["${base}"] } }) so a sign-in or sign-out drops the pages kept for the previous visitor; if it does not, add it to keepAlive.ignoreCookies.`,
      )
    }
    if (changed !== undefined) {
      headers.append(
        "set-cookie",
        epochCookie(
          changed.secure || servedOverHttps(request, sent),
          randomEpoch(),
          changed.deleted ? {} : { maxAge: changed.maxAge, expires: changed.expires },
        ),
      )
      return
    }
    if (renewed === undefined) return
    const lifetime = { maxAge: renewed.maxAge, expires: renewed.expires }
    for (const secure of [true, false]) {
      const held = sent[secure ? EPOCH_COOKIE : LOCAL_EPOCH_COOKIE]
      if (held === undefined || !EPOCH_VALUE.test(held)) continue
      headers.append("set-cookie", epochCookie(secure, held, lifetime))
      return
    }
    // An epoch that already expired, or was never set: a fresh one, so pages kept without one drop.
    headers.append(
      "set-cookie",
      epochCookie(renewed.secure || servedOverHttps(request, sent), randomEpoch(), lifetime),
    )
  }
}

/** The response-cookie surface {@link rotateIdentityEpoch} needs: nifra's handler context. */
export interface IdentityEpochContext {
  readonly request: Request
  readonly set: { cookie(name: string, value: string, options?: CookieOptions): void }
}

/**
 * Rotate the identity epoch from a flow that changes who is signed in without changing a cookie
 * `createWebApp` watches - say, a session kept server-side under a cookie whose value stays the
 * same. Every tab then drops the pages it kept alive for the previous visitor.
 */
export function rotateIdentityEpoch(c: IdentityEpochContext): void {
  const request = c.request
  const secure = servedOverHttps(
    { url: request.url, header: (name) => request.headers.get(name) },
    parseCookies(request.headers.get("cookie")),
  )
  c.set.cookie(secure ? EPOCH_COOKIE : LOCAL_EPOCH_COOKIE, randomEpoch(), {
    path: "/",
    sameSite: "lax",
    secure,
    httpOnly: false,
  })
}

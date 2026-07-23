/**
 * Draft / preview mode — let an editor see unpublished content by flipping a signed cookie that
 * loaders read (`ctx.draft`) and ISR bypasses (fresh render, never cached). The cookie is **HMAC-signed**
 * (so a visitor can't forge it) and **HttpOnly** (JS can't read it). You gate `enableDraft` yourself —
 * behind an editor login or a `?token=` check — exactly like Next's `draftMode().enable()`.
 *
 *   // a route you've protected (e.g. checked ?token= against a secret):
 *   app.get("/api/draft", async (c) => {
 *     await enableDraft(c, env.DRAFT_SECRET)
 *     return redirect("/")
 *   })
 *
 *   // wire the same secret so the framework can verify the cookie:
 *   createWebApp({ ..., draftSecret: env.DRAFT_SECRET })   // → loaders get ctx.draft
 *   withISR(app, { ..., draftSecret: env.DRAFT_SECRET })   // → editors bypass the cache
 */
import {
  type CookieOptions,
  parseCookies,
  serializeCookie,
  signValue,
  unsignValue,
} from "@nifrajs/core/server"
import { timingSafeEqual } from "./internal/timing-safe-equal.ts"

/** The cookie name nifra uses for draft/preview mode. */
export const DRAFT_COOKIE = "__nifra_draft"

// The signed cookie's payload is a fixed marker — a *valid signature* (not the value) is the signal
// that the server issued this via enableDraft(). Nothing secret is stored in it.
const DRAFT_MARKER = "1"

/** The response-cookie surface `enableDraft`/`disableDraft` need — nifra's `c.set`. Structural, so any
 * nifra handler context satisfies it without importing the full `Context`. */
export interface DraftCookieControls {
  cookie(name: string, value: string, options?: CookieOptions): void
  deleteCookie(name: string, options?: { readonly path?: string; readonly domain?: string }): void
}

export interface EnableDraftOptions {
  /** Cookie lifetime in **seconds** (default `3600` = 1h). Keep it short — draft is an editor session. */
  readonly maxAgeSeconds?: number
  /** Cookie `Path` (default `"/"`). */
  readonly path?: string
  /** Override the `Secure` attribute (defaults to `true` — secure-by-default). Pass `false` only for
   * local `http://` dev, where a `Secure` cookie isn't stored. */
  readonly secure?: boolean
}

/**
 * Turn draft mode **on** for this client by setting a signed, HttpOnly `__nifra_draft` cookie. Call it
 * from a route you've already authorized. `secret` signs the cookie — pass the SAME secret to
 * `createWebApp({ draftSecret })` and `withISR({ draftSecret })` so the framework can verify it.
 */
export async function enableDraft(
  c: { readonly set: DraftCookieControls },
  secret: string,
  options: EnableDraftOptions = {},
): Promise<void> {
  const signed = await signValue(DRAFT_MARKER, secret)
  c.set.cookie(DRAFT_COOKIE, signed, draftCookieOptions(options))
}

/**
 * The attributes draft mode always sets. Shared by {@link enableDraft} (which writes through
 * `c.set.cookie`) and {@link previewEndpoint} (which serializes its own `Set-Cookie`), so the two
 * can't drift on the properties that make the cookie unforgeable and unreadable from JS.
 *
 * `secure` is resolved here rather than left to the caller: `serializeCookie` is pure and applies
 * **no** security defaults, so the `previewEndpoint` path would silently emit a cookie without
 * `Secure` — over plain HTTP that hands the draft cookie to any network observer. Passing it
 * explicitly makes both paths identical instead of one inheriting a default the other never sees.
 */
function draftCookieOptions(options: EnableDraftOptions): CookieOptions {
  // Explicit security attributes (don't lean on the context default): signed + HttpOnly + SameSite=Lax.
  return {
    httpOnly: true,
    sameSite: "lax",
    path: options.path ?? "/",
    maxAge: options.maxAgeSeconds ?? 3600,
    secure: options.secure ?? true,
  }
}

/** Turn draft mode **off**: clear the `__nifra_draft` cookie. Match the `path` used in `enableDraft`. */
export function disableDraft(
  c: { readonly set: DraftCookieControls },
  options: { readonly path?: string } = {},
): void {
  c.set.deleteCookie(DRAFT_COOKIE, { path: options.path ?? "/" })
}

/**
 * Whether `request` carries a **valid** signed draft cookie (constant-time verify via `unsignValue`).
 * `createWebApp` uses it to set `ctx.draft`; `withISR` uses it to bypass the cache for editors. A
 * missing, forged, or tampered cookie returns `false`.
 */
export async function isDraftEnabled(request: Request, secret: string): Promise<boolean> {
  const cookie = parseCookies(request.headers.get("cookie"))[DRAFT_COOKIE]
  if (cookie === undefined) return false
  return (await unsignValue(cookie, secret)) !== null
}

/**
 * Accept only a same-site destination, or `null`.
 *
 * A redirect target that arrives in the query string is attacker-controlled: anyone can mint a link
 * to your own preview route and choose where the editor lands. "Starts with `/`" is the check people
 * write and it is not enough — `//evil.com` is a protocol-relative URL and `/\evil.com` is normalized
 * to one by browsers, so both start with a slash and navigate off-site. Control characters are refused
 * as well, since a newline in a `Location` header splits the response.
 */
function safeRedirectPath(value: string): string | null {
  if (!value.startsWith("/")) return null
  if (value.startsWith("//") || value.startsWith("/\\")) return null
  // Escaped rather than written literally: raw control bytes in source make the file read as binary
  // to ordinary tooling (grep, diffs) and are one reformat away from being silently mangled.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point - this IS the check that refuses them.
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null
  return value
}

/** Config for {@link previewEndpoint}. */
export interface PreviewEndpointOptions {
  /** Shared secret the preview link must carry. Compared in **constant time**. */
  readonly secret: string
  /** Secret that **signs** the draft cookie — the same one passed to `createWebApp({ draftSecret })`
   * and `withISR({ draftSecret })`. Keep it distinct from {@link secret}: that one travels in URLs
   * (logs, `Referer`, browser history), this one never leaves the server. */
  readonly draftSecret: string
  /** Query parameter carrying the token. Default `"token"`. */
  readonly tokenParam?: string
  /** Query parameter carrying the destination. Default `"to"`. */
  readonly redirectParam?: string
  /** Where to send the editor when the destination parameter is absent. Default `"/"`. Must be
   * site-relative; a non-relative value throws at construction rather than at request time. */
  readonly fallbackPath?: string
  /** Cookie lifetime/path/secure overrides, exactly as {@link enableDraft} takes them. */
  readonly cookie?: EnableDraftOptions
}

/**
 * A **preview / draft-mode entry point** — a `fetch` handler that checks a preview token, turns draft
 * mode on, and redirects the editor to the page they wanted. `GET` with `?token=<secret>&to=/some/path`;
 * mount it on a nifra route, e.g. `app.get("/api/preview", (c) => handler(c.req))`.
 *
 * This is the link-borne sibling of `revalidateEndpoint`. It exists because the alternative — telling
 * you to gate the route yourself — means hand-rolling two checks that are easy to get subtly wrong and
 * that fail silently when you do: the token compare must not exit early on the first wrong character,
 * and the `?to=` destination must not be allowed to point off-site. Both are handled here.
 *
 * A CMS "Preview" button is a plain link, so the token has to ride the query string. That has a cost
 * no endpoint can remove — the secret lands in server logs, the `Referer` header, and browser history.
 * Use a preview token minted for that purpose, rotate it, and never reuse a token that grants anything
 * beyond draft mode.
 *
 * Wrong or missing token → `401`; an off-site `to` → `400`; success → `302` with the signed cookie and
 * `Cache-Control: no-store`, so no shared cache can ever replay one editor's draft session to a visitor.
 */
export function previewEndpoint(
  options: PreviewEndpointOptions,
): (request: Request) => Promise<Response> {
  const tokenParam = options.tokenParam ?? "token"
  const redirectParam = options.redirectParam ?? "to"
  const fallbackPath = options.fallbackPath ?? "/"
  // Fail at construction, not on the request that happens to omit `?to=`: a misconfigured fallback is
  // a deploy-time mistake and should surface at boot rather than as a rare 400 in production.
  if (safeRedirectPath(fallbackPath) === null) {
    throw new Error(
      `[nifra] previewEndpoint fallbackPath must be a site-relative path, got ${JSON.stringify(fallbackPath)}`,
    )
  }
  const cookieOptions = draftCookieOptions(options.cookie ?? {})
  return async (request) => {
    const url = new URL(request.url)
    if (!timingSafeEqual(url.searchParams.get(tokenParam) ?? "", options.secret)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
    }
    const requested = url.searchParams.get(redirectParam)
    const destination = requested === null ? fallbackPath : safeRedirectPath(requested)
    if (destination === null) {
      return Response.json({ ok: false, error: "invalid_redirect" }, { status: 400 })
    }
    const signed = await signValue(DRAFT_MARKER, options.draftSecret)
    return new Response(null, {
      status: 302,
      headers: {
        location: destination,
        "set-cookie": serializeCookie(DRAFT_COOKIE, signed, cookieOptions),
        "cache-control": "no-store",
      },
    })
  }
}

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
import { type CookieOptions, parseCookies, signValue, unsignValue } from "@nifrajs/core/server"

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
  // Explicit security attributes (don't lean on the context default): signed + HttpOnly + SameSite=Lax.
  const cookieOptions: CookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    path: options.path ?? "/",
    maxAge: options.maxAgeSeconds ?? 3600,
    ...(options.secure === undefined ? {} : { secure: options.secure }),
  }
  c.set.cookie(DRAFT_COOKIE, signed, cookieOptions)
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

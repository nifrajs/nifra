/**
 * Framework-agnostic Auth.js client - `fetch` against the mounted Auth.js endpoints, no DOM
 * framework involved. Every UI adapter builds on this: pass it a base path (default
 * `/api/auth`, matching the backend mount default) and an optional `fetch` override for tests
 * or loaders that must forward headers.
 *
 * ```ts
 * import { createAuthClient } from "@nifrajs/authjs/client"
 *
 * const auth = createAuthClient()
 * await auth.signIn("github") // navigates to the provider (browser only)
 * await auth.signOut() // posts signout, then navigates home
 * const session = await auth.getSession() // works anywhere fetch does
 * ```
 */
import type { Session } from "@auth/core/types"

export type { Session } from "@auth/core/types"

export interface AuthClientOptions {
  /** Auth.js mount path. Default `"/api/auth"`. */
  readonly basePath?: string
  /** `fetch` implementation. Default global `fetch` - override in tests or to forward headers. */
  readonly fetch?: typeof fetch
}

export interface SignInOptions {
  /** Where the provider returns afterwards. Default the current page. */
  readonly callbackUrl?: string
}

export interface SignOutOptions {
  /** Where to land after sign-out. Default `"/"`. Set `redirect: false` to stay put. */
  readonly callbackUrl?: string
  readonly redirect?: boolean
}

/** Build `/api/auth/signin/:provider?callbackUrl=…` without touching `window` (testable). */
export function signInUrl(
  providerId: string,
  options: { readonly basePath?: string; readonly callbackUrl: string },
): string {
  const base = options.basePath ?? "/api/auth"
  return `${base}/signin/${encodeURIComponent(providerId)}?callbackUrl=${encodeURIComponent(options.callbackUrl)}`
}

const currentUrl = (): string => {
  if (typeof window === "undefined" || typeof window.location?.href !== "string") {
    throw new Error("[nifra/authjs] signIn needs a browser page (no window.location.href)")
  }
  return window.location.href
}

function isSafeRelativePath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false
  for (let i = 1; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return false
  }
  return true
}

/** Keep post-auth navigation on this origin; an unsafe callback is never an external redirect. */
function safeNavigationTarget(value: string): string {
  if (isSafeRelativePath(value)) return value
  if (typeof window !== "undefined" && typeof window.location?.href === "string") {
    try {
      const target = new URL(value, window.location.href)
      if (
        (target.protocol === "http:" || target.protocol === "https:") &&
        target.origin === window.location.origin
      ) {
        return target.href
      }
    } catch {
      // Invalid callback URLs fall back to the home path rather than becoming a navigation sink.
    }
  }
  return "/"
}

const navigate = (url: string): void => {
  if (typeof window === "undefined" || typeof window.location?.assign !== "function") {
    throw new Error("[nifra/authjs] navigation needs a browser page")
  }
  window.location.assign(safeNavigationTarget(url))
}

export interface AuthClient {
  /** The Auth.js session, or `null` when unauthenticated. Usable anywhere `fetch` runs. */
  getSession(init?: RequestInit): Promise<Session | null>
  /** Start an OAuth/OIDC sign-in (browser only): navigates to the provider via Auth.js. */
  signIn(providerId: string, options?: SignInOptions): void
  /** Sign out via the CSRF-protected endpoint, then navigate (unless `redirect: false`). */
  signOut(options?: SignOutOptions): Promise<void>
}

/** Create the client. Stateless - every call hits the endpoints, so servers stay authoritative. */
export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const base = options.basePath ?? "/api/auth"
  const impl = options.fetch ?? fetch
  return {
    async getSession(init?: RequestInit): Promise<Session | null> {
      const response = await impl(`${base}/session`, init)
      if (!response.ok) return null
      const session = (await response.json()) as Session | null
      return session?.user ? session : null
    },
    signIn(providerId: string, signInOptions: SignInOptions = {}): void {
      navigate(
        signInUrl(providerId, {
          basePath: base,
          callbackUrl: signInOptions.callbackUrl ?? currentUrl(),
        }),
      )
    },
    async signOut(signOutOptions: SignOutOptions = {}): Promise<void> {
      const csrf = (await (await impl(`${base}/csrf`)).json()) as { csrfToken?: unknown }
      if (typeof csrf.csrfToken !== "string" || csrf.csrfToken === "") {
        throw new Error("[nifra/authjs] signOut: CSRF token endpoint did not answer")
      }
      const callbackUrl = signOutOptions.callbackUrl ?? "/"
      const response = await impl(`${base}/signout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl }),
      })
      if (!response.ok) {
        throw new Error(`[nifra/authjs] signOut failed (HTTP ${response.status})`)
      }
      if (signOutOptions.redirect !== false) navigate(callbackUrl)
    },
  }
}

/**
 * Route guards — run at the top of a protected loader/action/handler. On a missing session they
 * **throw a `Response`** (a 302 to your login path, or a 401); nifra returns a thrown Response as-is, so
 * the guard short-circuits the rest of the handler. Pairs with `@nifrajs/auth` sessions but only needs the
 * `Session` shape, so it's framework-agnostic.
 */
import type { Session } from "./session.ts"

/** What a guard does when the check fails: 302 to `redirectTo` (a same-origin path), or — omitted — a
 * 401 JSON (`{ ok: false, error: "unauthorized" }`). */
export interface GuardOptions {
  readonly redirectTo?: string
}

const rejection = (options: GuardOptions): Response => {
  const to = options.redirectTo
  if (to === undefined) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  // Same-origin guard (mirrors @nifrajs/web `redirect`): a single leading "/", never "//host" or an
  // absolute URL. `redirectTo` is dev-authored, so a bad value is a config bug — fail loud here.
  if (!to.startsWith("/") || to.startsWith("//")) {
    throw new Error(
      `[nifra/auth] guard redirectTo must be a same-origin path beginning with "/" (got ${JSON.stringify(to)})`,
    )
  }
  return new Response(null, { status: 302, headers: { location: to } })
}

/**
 * Require a non-empty session. Returns it when present; otherwise throws a `Response` (302/401). Use at
 * the top of a protected loader:
 * `const session = requireSession(await sessions.get(c), { redirectTo: "/login" })`.
 */
export function requireSession<Data extends Record<string, unknown>>(
  session: Session<Data>,
  options: GuardOptions = {},
): Session<Data> {
  if (!session.isEmpty) return session
  throw rejection(options)
}

/**
 * Require a specific session key (e.g. the `userId` a login set) to be present. Returns its value
 * (narrowed non-nullish); otherwise throws like {@link requireSession}. The common "who is the user"
 * guard: `const userId = requireUser(await sessions.get(c), "userId", { redirectTo: "/login" })`.
 */
export function requireUser<Data extends Record<string, unknown>, K extends keyof Data>(
  session: Session<Data>,
  key: K,
  options: GuardOptions = {},
): NonNullable<Data[K]> {
  const value = session.get(key)
  // Narrowed by the runtime check; the generic `Data[K] | undefined` doesn't auto-narrow to NonNullable.
  if (value !== undefined && value !== null) return value as NonNullable<Data[K]>
  throw rejection(options)
}

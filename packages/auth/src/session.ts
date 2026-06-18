/**
 * The session manager — `createSessions<Data>()` returns get/commit/destroy/regenerate bound to a
 * signing secret + cookie config. Two modes:
 *   • **store mode** (a {@link SessionStore} is given): a random session id rides a signed cookie; the
 *     data lives in the store. Big/sensitive data, server-side revocation.
 *   • **cookie mode** (no store): the data itself is signed into the cookie (stateless, edge-friendly,
 *     ≤4 KB). No server state.
 * The cookie value is **always HMAC-signed** (tamper-evident; verified constant-time) and the session
 * cookie is always `HttpOnly`. Reads **fail closed** — a tampered/missing/expired cookie yields a fresh
 * anonymous session, never an error.
 */
import { type CookieOptions, parseCookies, signValue, unsignValue } from "@nifrajs/core"
import type { SessionRecord, SessionStore } from "./store.ts"

/** The cookie + response surface the manager needs — a structural subset of nifra's `Context`, so any
 * `c` satisfies it and it's testable with a stub. */
export interface SessionContext {
  readonly cookies: Readonly<Record<string, string>>
  readonly set: {
    cookie(name: string, value: string, options?: CookieOptions): void
    deleteCookie(name: string, options?: { readonly path?: string; readonly domain?: string }): void
  }
}

/** A typed session handle. Every key is optional — a fresh session is empty. */
export interface Session<Data extends Record<string, unknown> = Record<string, unknown>> {
  get<K extends keyof Data>(key: K): Data[K] | undefined
  set<K extends keyof Data>(key: K, value: Data[K]): void
  unset(key: keyof Data): void
  has(key: keyof Data): boolean
  /** Wipe all data (the session id is kept). To end the session entirely, call `manager.destroy`. */
  clear(): void
  /** A snapshot of the current data. */
  readonly data: Readonly<Partial<Data>>
  readonly isEmpty: boolean
}

/** Cookie attributes a session may tune. `httpOnly` is **not** offered — a session cookie is always
 * HttpOnly; `maxAge`/`expires` are derived from the session's lifetime. */
export type SessionCookieOptions = Pick<CookieOptions, "secure" | "sameSite" | "path" | "domain">

export interface SessionOptions {
  /** Signing secret (≥ 16 chars). Rotating it invalidates all existing sessions. */
  readonly secret: string
  /** Provide a store for **store mode**; omit for **cookie mode** (stateless). */
  readonly store?: SessionStore
  /** Cookie name. Default `nifra_session`. */
  readonly cookieName?: string
  /** Session lifetime in **seconds**. Default 7 days. */
  readonly maxAge?: number
  /** Slide the expiry forward on every commit (default `true`); `false` = fixed absolute expiry. */
  readonly rolling?: boolean
  /** Extra cookie attributes (the session cookie is always HttpOnly; `Secure`/`SameSite=Lax`/`Path=/`
   * default via `c.set.cookie`). Pass `{ secure: false }` for local http dev. */
  readonly cookie?: SessionCookieOptions
  /** Clock (ms) — injected for testability; production passes `() => Date.now()` (the default). */
  readonly now?: () => number
}

export interface SessionManager<Data extends Record<string, unknown> = Record<string, unknown>> {
  /** Load the session from the request cookie (verified + un-expired), or a fresh anonymous one. */
  get(c: SessionContext): Promise<Session<Data>>
  /** Read-only load from a raw `Request` — for `@nifrajs/web` loaders (which can read the request but not
   * write cookies). Identical verify/expiry to {@link get}; commit/destroy in a route or action. */
  read(request: Request): Promise<Session<Data>>
  /** Persist the session: write the store (store mode) + the signed cookie. */
  commit(c: SessionContext, session: Session<Data>): Promise<void>
  /** End the session: drop the store record (store mode) + clear the cookie. */
  destroy(c: SessionContext, session?: Session<Data>): Promise<void>
  /** Rotate the session id on the next commit (call on privilege change — login — to defend against
   * session fixation). Data is preserved; the old store record is dropped. */
  regenerate(session: Session<Data>): void
}

const DAY_SECONDS = 86_400
// 256-bit floor, matching @nifrajs/core's signed-cookie/webhook guard. Sessions sign via core's
// signValue (which enforces the same bar); this early check gives an auth-specific message before
// delegating. Measured in UTF-8 bytes, not characters.
const MIN_SECRET_BYTES = 32
const SECRET_ENCODER = new TextEncoder()

const encodeBase64Url = (bytes: Uint8Array): string => {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** A 256-bit random session id (base64url). High-entropy + unguessable — the cookie also signs it. */
const randomId = (): string => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))

interface Payload {
  data: Record<string, unknown>
  expiresAt: number
}

/** Validate a cookie-mode payload at the trust boundary — malformed JSON / shape → `null` (no session). */
const parsePayload = (json: string): Payload | null => {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.expiresAt !== "number" || !Number.isFinite(obj.expiresAt)) return null
  if (typeof obj.data !== "object" || obj.data === null) return null
  return { data: obj.data as Record<string, unknown>, expiresAt: obj.expiresAt }
}

export function createSessions<Data extends Record<string, unknown> = Record<string, unknown>>(
  options: SessionOptions,
): SessionManager<Data> {
  const { secret, store } = options
  if (SECRET_ENCODER.encode(secret).length < MIN_SECRET_BYTES) {
    throw new Error(
      `[nifra/auth] session secret must be at least ${MIN_SECRET_BYTES} bytes (256-bit). Generate one with: openssl rand -base64 32`,
    )
  }
  const cookieName = options.cookieName ?? "nifra_session"
  const maxAge = options.maxAge ?? 7 * DAY_SECONDS
  const rolling = options.rolling ?? true
  const now = options.now ?? (() => Date.now())
  // Annotated (not just `?? {}`) so `cookieOpts.path`/`.domain` stay typed — `?? {}` alone widens the
  // type to include the empty-object literal, which the package's build tsconfig rejects on access.
  const cookieOpts: SessionCookieOptions = options.cookie ?? {}

  interface State {
    id: string | undefined
    readonly data: Map<keyof Data, Data[keyof Data]>
    expiresAt: number | undefined
    regenerate: boolean
  }
  // Per-manager so the WeakMap is typed to this `Data` (no `any`); a session can only be committed by
  // the manager that created it.
  const states = new WeakMap<Session<Data>, State>()

  const make = (init: {
    id?: string
    data?: Record<string, unknown>
    expiresAt?: number
  }): Session<Data> => {
    const state: State = {
      id: init.id,
      // The Map erases per-key value types; the public generic signatures restore them at the edge.
      data: new Map(Object.entries(init.data ?? {}) as [keyof Data, Data[keyof Data]][]),
      expiresAt: init.expiresAt,
      regenerate: false,
    }
    const session: Session<Data> = {
      get: <K extends keyof Data>(key: K) => state.data.get(key) as Data[K] | undefined,
      set: (key, value) => {
        state.data.set(key, value)
      },
      unset: (key) => {
        state.data.delete(key)
      },
      has: (key) => state.data.has(key),
      clear: () => {
        state.data.clear()
      },
      get data() {
        return Object.fromEntries(state.data) as Partial<Data>
      },
      get isEmpty() {
        return state.data.size === 0
      },
    }
    states.set(session, state)
    return session
  }

  const stateOf = (session: Session<Data>, op: string): State => {
    const state = states.get(session)
    if (state === undefined) {
      throw new Error(`[nifra/auth] ${op}: session was not created by this manager`)
    }
    return state
  }

  const loadFromRaw = async (raw: string | undefined): Promise<Session<Data>> => {
    if (raw === undefined || raw === "") return make({})
    const unsigned = await unsignValue(raw, secret)
    if (unsigned === null) return make({}) // tampered / wrong secret → fail closed (anonymous)

    if (store !== undefined) {
      const record = await store.get(unsigned)
      if (record === undefined) return make({})
      if (record.expiresAt <= now()) {
        await store.delete(unsigned) // expired — evict + treat as no session
        return make({})
      }
      return make({ id: unsigned, data: record.data, expiresAt: record.expiresAt })
    }

    const payload = parsePayload(unsigned)
    if (payload === null || payload.expiresAt <= now()) return make({})
    return make({ data: payload.data, expiresAt: payload.expiresAt })
  }

  const get = (c: SessionContext): Promise<Session<Data>> => loadFromRaw(c.cookies[cookieName])

  // Read-only load from a raw Request — for @nifrajs/web loaders, which have the request but can't write
  // cookies (commit/destroy belong in a route/action with the full Context). Same verify + expiry.
  const read = (request: Request): Promise<Session<Data>> =>
    loadFromRaw(parseCookies(request.headers.get("cookie"))[cookieName])

  const writeCookie = (c: SessionContext, value: string, expiresAt: number): void => {
    const maxAgeSeconds = Math.max(0, Math.floor((expiresAt - now()) / 1000))
    c.set.cookie(cookieName, value, { ...cookieOpts, maxAge: maxAgeSeconds })
  }

  const commit = async (c: SessionContext, session: Session<Data>): Promise<void> => {
    const state = stateOf(session, "commit")
    // Rolling → slide the expiry; absolute → keep the original (set on the first commit).
    const expiresAt =
      rolling || state.expiresAt === undefined ? now() + maxAge * 1000 : state.expiresAt
    state.expiresAt = expiresAt
    const data = Object.fromEntries(state.data) as Record<string, unknown>

    if (store !== undefined) {
      if (state.regenerate) {
        if (state.id !== undefined) await store.delete(state.id) // drop the pre-rotation session
        state.id = undefined
        state.regenerate = false
      }
      if (state.id === undefined) state.id = randomId()
      await store.set(state.id, { data, expiresAt } satisfies SessionRecord)
      writeCookie(c, await signValue(state.id, secret), expiresAt)
      return
    }
    // Cookie mode: the (signed) payload IS the cookie. serializeCookie enforces the 4 KB cap.
    writeCookie(
      c,
      await signValue(JSON.stringify({ data, expiresAt } satisfies Payload), secret),
      expiresAt,
    )
  }

  const destroy = async (c: SessionContext, session?: Session<Data>): Promise<void> => {
    if (store !== undefined && session !== undefined) {
      const state = states.get(session)
      if (state?.id !== undefined) await store.delete(state.id)
    }
    c.set.deleteCookie(cookieName, {
      path: cookieOpts.path ?? "/",
      ...(cookieOpts.domain !== undefined ? { domain: cookieOpts.domain } : {}),
    })
  }

  const regenerate = (session: Session<Data>): void => {
    stateOf(session, "regenerate").regenerate = true
  }

  return { get, read, commit, destroy, regenerate }
}

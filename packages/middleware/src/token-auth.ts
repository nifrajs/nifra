import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import { definePlugin, type NifraPlugin } from "@nifrajs/core/server"

type MaybePromise<T> = T | Promise<T>

/**
 * A token-auth plugin (`bearer` / `apiKey`). Apply it with `app.use(auth)` — it rejects unauthorized
 * requests to **routes defined after it** with `401` (unless `optional`). Read the verified principal
 * inside a handler/loader via {@link AuthPlugin.principal} (nullable) or
 * {@link AuthPlugin.requirePrincipal} (throws `401` when absent). The principal is verified once per
 * request and cached, so reading it is free.
 *
 * `beforeHandle` is **order-scoped**: place `app.use(auth)` before the routes it should guard. Hold the
 * returned instance to read the principal (mirrors `@nifrajs/auth`'s `sessions.get(c)` and
 * `@nifrajs/better-auth`'s `getSession(auth, req)`):
 *
 * ```ts
 * const auth = bearer({ verify: (t) => lookupUser(t) }) // P = User (inferred)
 * const app = server().use(auth).get("/me", (c) => auth.requirePrincipal(c.req))
 * ```
 */
export type AuthPlugin<P> = NifraPlugin & {
  /** The verified principal for this request, or `null` (no/invalid token in `optional` mode). */
  principal(request: Request): P | null
  /** The verified principal, or **throws a `401` `Response`** when absent. */
  requirePrincipal(request: Request): P
}

interface TokenAuthConfig<P> {
  readonly name: string
  /** Pull the credential out of the request (e.g. the `Bearer` token or an `x-api-key` header). */
  readonly extract: (request: Request) => string | undefined
  /** Verify the credential → a principal (truthy) or `null`/`undefined` (rejected). */
  readonly verify: (token: string) => MaybePromise<P | null | undefined>
  readonly optional: boolean
  /** `WWW-Authenticate` challenge value sent on `401` (bearer only). */
  readonly challenge?: string
}

function createTokenAuth<P>(config: TokenAuthConfig<P>): AuthPlugin<P> {
  // Per-request principal cache: verify runs once (in beforeHandle), reads are free + can't desync.
  const store = new WeakMap<Request, P>()
  const reject = (): Response =>
    Response.json(
      { ok: false, error: "unauthorized" },
      {
        status: 401,
        headers: config.challenge !== undefined ? { "www-authenticate": config.challenge } : {},
      },
    )
  const plugin = definePlugin(config.name, (app) =>
    app.beforeHandle(async (c: { readonly req: Request }) => {
      const token = config.extract(c.req)
      // Empty string is treated as "no credential" — never passed to verify.
      const principal = token !== undefined && token !== "" ? await config.verify(token) : null
      if (principal !== null && principal !== undefined) {
        store.set(c.req, principal)
        return undefined // authorized — continue to the handler
      }
      return config.optional ? undefined : reject() // 401 short-circuits (skips the handler)
    }),
  )
  const instrumented = config.optional
    ? plugin
    : withRouteAssurance(plugin, {
        id: NIFRA_ASSURANCE.AUTHENTICATED,
        source: config.name,
        scope: "subsequent",
      })
  return Object.assign(instrumented, {
    principal: (request: Request): P | null => store.get(request) ?? null,
    requirePrincipal: (request: Request): P => {
      const principal = store.get(request)
      if (principal === undefined) throw reject()
      return principal
    },
  }) as AuthPlugin<P>
}

export interface BearerOptions<P> {
  /** Verify a bearer token → a principal (truthy) or `null`/`undefined` (rejected). May be async
   * (DB/JWT lookup). For a constant-secret comparison, use a constant-time compare — never `===`. */
  readonly verify: (token: string) => MaybePromise<P | null | undefined>
  /** When `true`, requests without a valid token pass through (`principal` is `null`) instead of `401`. */
  readonly optional?: boolean
  /** `realm` for the `WWW-Authenticate: Bearer` header on `401`. Default `"api"`. */
  readonly realm?: string
}

/**
 * `Authorization: Bearer <token>` authentication. Parses the header, runs `verify`, and rejects with
 * `401` (+ `WWW-Authenticate: Bearer`) when the token is missing/invalid (unless `optional`). The
 * verified principal is read via the returned instance — see {@link AuthPlugin}.
 */
export function bearer<P>(options: BearerOptions<P>): AuthPlugin<P> {
  const realm = options.realm ?? "api"
  return createTokenAuth({
    name: "bearer",
    extract: (request) => {
      const header = request.headers.get("authorization")
      return header?.startsWith("Bearer ") === true ? header.slice(7).trim() : undefined
    },
    verify: options.verify,
    optional: options.optional === true,
    challenge: `Bearer realm="${realm}"`,
  })
}

export interface ApiKeyVerifyOptions<P> {
  /** Verify an API key → a principal or `null`/`undefined` (rejected). May be async. */
  readonly verify: (key: string) => MaybePromise<P | null | undefined>
  /** Header carrying the key. Default `"x-api-key"`. */
  readonly header?: string
  readonly optional?: boolean
}

export interface ApiKeyStaticOptions {
  /** A fixed set of valid keys. Compared in **constant time** (see below); the matched key becomes the
   * principal. Use `verify` instead for DB-backed / per-tenant keys. */
  readonly keys: readonly string[]
  readonly header?: string
  readonly optional?: boolean
}

const textEncoder = new TextEncoder()

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(input)))
}

/** Constant-time byte compare. Inputs here are always 32-byte SHA-256 digests, so the early
 * length check never leaks key length (digests are fixed-width). */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/**
 * Build a constant-time verifier for a fixed key set. Each valid key is hashed once (SHA-256, fixed
 * 32 bytes); per request the candidate is hashed and compared against every digest **without early
 * exit**, so timing depends only on the (public) key count — never on the secret value or which key
 * matched. Portable across all runtimes via WebCrypto.
 */
function staticKeyVerify(keys: readonly string[]): (candidate: string) => Promise<string | null> {
  const validDigests = Promise.all(keys.map((key) => sha256(key)))
  return async (candidate) => {
    const candidateDigest = await sha256(candidate)
    let matched = false
    for (const digest of await validDigests) {
      // No early `break`: every comparison runs so total time is independent of which key (if any) hit.
      if (timingSafeEqualBytes(candidateDigest, digest)) matched = true
    }
    return matched ? candidate : null
  }
}

/**
 * API-key authentication via a header (default `x-api-key`). Two forms:
 * - `apiKey({ keys })` — a fixed key set, compared in **constant time**; the matched key is the principal.
 * - `apiKey({ verify })` — custom (e.g. DB-backed) verification returning a typed principal.
 *
 * Rejects missing/invalid keys with `401` (unless `optional`). Read the principal via the returned
 * instance — see {@link AuthPlugin}.
 */
export function apiKey(options: ApiKeyStaticOptions): AuthPlugin<string>
export function apiKey<P>(options: ApiKeyVerifyOptions<P>): AuthPlugin<P>
export function apiKey<P>(
  options: ApiKeyStaticOptions | ApiKeyVerifyOptions<P>,
): AuthPlugin<P | string> {
  const header = (options.header ?? "x-api-key").toLowerCase()
  const verify = "keys" in options ? staticKeyVerify(options.keys) : options.verify
  return createTokenAuth<P | string>({
    name: "apiKey",
    extract: (request) => request.headers.get(header) ?? undefined,
    verify,
    optional: options.optional === true,
  })
}

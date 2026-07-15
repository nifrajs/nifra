import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import { definePlugin, type NifraPlugin } from "@nifrajs/core/server"
import {
  base64UrlDecode,
  jsonError,
  type MaybePromise,
  parseCookies,
  quotedHeaderValue,
  secretBytes,
  utf8Bytes,
} from "./_utils.ts"

export type JwtAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "RS384" | "RS512"

export interface JwtHeader {
  readonly alg: string
  readonly kid?: string
  readonly typ?: string
  readonly [key: string]: unknown
}

export interface JwtClaims {
  readonly iss?: string
  readonly sub?: string
  readonly aud?: string | readonly string[]
  readonly exp?: number
  readonly nbf?: number
  readonly iat?: number
  readonly jti?: string
  readonly [claim: string]: unknown
}

export interface VerifiedJwt<C extends JwtClaims = JwtClaims> {
  readonly header: JwtHeader
  readonly claims: C
  readonly token: string
}

export type VerifyJwtResult<C extends JwtClaims = JwtClaims> =
  | { readonly ok: true; readonly data: VerifiedJwt<C> }
  | { readonly ok: false; readonly error: Error }

export interface JwkKey {
  readonly kty?: string
  readonly kid?: string
  readonly alg?: string
  readonly use?: string
  readonly key_ops?: readonly string[]
  readonly [key: string]: unknown
}

export type JwtVerificationKey = string | Uint8Array | CryptoKey | JwkKey
export type JwtKeyResolver = (
  header: JwtHeader,
  claims: JwtClaims,
) => MaybePromise<JwtVerificationKey | null | undefined>

export interface VerifyJwtOptions {
  readonly key: JwtVerificationKey | JwtKeyResolver
  readonly algorithms: readonly JwtAlgorithm[]
  readonly issuer?: string | readonly string[]
  readonly audience?: string | readonly string[]
  readonly clockToleranceSec?: number
  readonly requiredClaims?: readonly string[]
  readonly requireExpiration?: boolean
  readonly maxAgeSec?: number
  readonly now?: () => number
}

export interface JwtOptions extends VerifyJwtOptions {
  readonly realm?: string
  readonly optional?: boolean
  /** Header carrying the token. Default `"authorization"` (`Bearer <token>`). */
  readonly header?: string
  /** Optional cookie fallback carrying the raw token. */
  readonly cookie?: string
}

export type JwtPlugin<C extends JwtClaims = JwtClaims> = NifraPlugin & {
  claims(request: Request): C | null
  requireClaims(request: Request): C
}

export interface JwksOptions {
  readonly url: string | URL
  readonly fetch?: typeof fetch
  readonly cacheMs?: number
  /**
   * Extra time to keep using the last successful key set when refresh fails.
   * Defaults to one cache window; set `0` to fail closed immediately on refresh errors.
   */
  readonly staleMs?: number
  readonly timeoutMs?: number
  readonly maxBytes?: number
}

const HASH: Record<JwtAlgorithm, "SHA-256" | "SHA-384" | "SHA-512"> = {
  HS256: "SHA-256",
  HS384: "SHA-384",
  HS512: "SHA-512",
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
}

const HMAC_ALGS = new Set<JwtAlgorithm>(["HS256", "HS384", "HS512"])
const RSA_ALGS = new Set<JwtAlgorithm>(["RS256", "RS384", "RS512"])
const JSON_DECODER = new TextDecoder("utf-8", { fatal: true })

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function jwtError(message: string): Error {
  return new Error(`jwt: ${message}`)
}

function decodeJsonSegment(segment: string): unknown {
  const bytes = base64UrlDecode(segment)
  if (bytes === null) throw jwtError("invalid base64url segment")
  try {
    return JSON.parse(JSON_DECODER.decode(bytes))
  } catch {
    throw jwtError("invalid JSON segment")
  }
}

function validateAlgorithms(algorithms: readonly JwtAlgorithm[]): Set<JwtAlgorithm> {
  if (algorithms.length === 0) throw new Error("jwt: algorithms must not be empty")
  return new Set(algorithms)
}

function nonNegativeSeconds(value: number | undefined, name: string): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value) || value < 0) throw jwtError(`${name} must be non-negative`)
  return value
}

function validateJwkForAlg(key: JwkKey, alg: JwtAlgorithm, kid: string | undefined): boolean {
  if (key.alg !== undefined && key.alg !== alg) return false
  if (key.use !== undefined && key.use !== "sig") return false
  if (key.key_ops !== undefined && !key.key_ops.includes("verify")) return false
  if (kid !== undefined && key.kid !== undefined && key.kid !== kid) return false
  if (HMAC_ALGS.has(alg)) return key.kty === "oct"
  if (RSA_ALGS.has(alg)) return key.kty === "RSA"
  return false
}

async function importKey(
  key: JwtVerificationKey,
  alg: JwtAlgorithm,
  kid: string | undefined,
): Promise<CryptoKey> {
  const hash = HASH[alg]
  if (key instanceof CryptoKey) return key
  if (typeof key === "string" || key instanceof Uint8Array) {
    if (!HMAC_ALGS.has(alg)) throw jwtError("symmetric key cannot verify an RSA token")
    return crypto.subtle.importKey("raw", secretBytes(key, "jwt"), { name: "HMAC", hash }, false, [
      "verify",
    ])
  }
  if (!validateJwkForAlg(key, alg, kid)) throw jwtError("JWK is not usable for this token")
  const importJwk = crypto.subtle.importKey as unknown as (
    format: "jwk",
    keyData: JwkKey,
    algorithm: unknown,
    extractable: boolean,
    keyUsages: string[],
  ) => Promise<CryptoKey>
  return importJwk.call(
    crypto.subtle,
    "jwk",
    key,
    RSA_ALGS.has(alg) ? { name: "RSASSA-PKCS1-v1_5", hash } : { name: "HMAC", hash },
    false,
    ["verify"],
  )
}

function verifyAlgorithm(alg: string, allowed: Set<JwtAlgorithm>): JwtAlgorithm {
  if (alg === "none") throw jwtError("alg none is not allowed")
  if (!allowed.has(alg as JwtAlgorithm)) throw jwtError("algorithm is not allowed")
  return alg as JwtAlgorithm
}

function includesString(expected: string | readonly string[] | undefined, actual: string): boolean {
  return expected === undefined
    ? true
    : typeof expected === "string"
      ? expected === actual
      : expected.includes(actual)
}

function validateClaims(claims: JwtClaims, options: VerifyJwtOptions): void {
  const now = options.now?.() ?? Math.floor(Date.now() / 1000)
  if (!Number.isFinite(now)) throw jwtError("now must be finite")
  const tolerance = nonNegativeSeconds(options.clockToleranceSec, "clockToleranceSec")
  const requireExpiration = options.requireExpiration !== false

  if (requireExpiration && typeof claims.exp !== "number") throw jwtError("exp is required")
  if (claims.exp !== undefined && (!Number.isFinite(claims.exp) || claims.exp <= now - tolerance)) {
    throw jwtError("token expired")
  }
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + tolerance)) {
    throw jwtError("token is not active yet")
  }
  if (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > now + tolerance)) {
    throw jwtError("iat is in the future")
  }
  if (options.maxAgeSec !== undefined) {
    nonNegativeSeconds(options.maxAgeSec, "maxAgeSec")
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat))
      throw jwtError("iat is required")
    if (now - claims.iat > options.maxAgeSec + tolerance) throw jwtError("token is too old")
  }
  if (options.issuer !== undefined) {
    if (typeof claims.iss !== "string" || !includesString(options.issuer, claims.iss)) {
      throw jwtError("issuer mismatch")
    }
  }
  if (options.audience !== undefined) {
    const got = claims.aud
    const gotList = typeof got === "string" ? [got] : Array.isArray(got) ? got : []
    const expected = typeof options.audience === "string" ? [options.audience] : options.audience
    if (!gotList.some((aud) => expected.includes(aud))) throw jwtError("audience mismatch")
  }
  for (const claim of options.requiredClaims ?? []) {
    if (!(claim in claims)) throw jwtError(`claim ${claim} is required`)
  }
}

export async function verifyJwt<C extends JwtClaims = JwtClaims>(
  token: string,
  options: VerifyJwtOptions,
): Promise<VerifiedJwt<C>> {
  const allowed = validateAlgorithms(options.algorithms)
  const parts = token.split(".")
  if (parts.length !== 3 || parts.some((p) => p === "")) throw jwtError("expected three segments")

  const headerRaw = decodeJsonSegment(parts[0]!)
  const claimsRaw = decodeJsonSegment(parts[1]!)
  if (!isObject(headerRaw) || typeof headerRaw.alg !== "string") throw jwtError("invalid header")
  if (headerRaw.crit !== undefined) throw jwtError("crit headers are not supported")
  if (!isObject(claimsRaw)) throw jwtError("invalid claims")

  const header = headerRaw as unknown as JwtHeader
  const claims = claimsRaw as unknown as C
  const alg = verifyAlgorithm(header.alg, allowed)

  const resolved =
    typeof options.key === "function" ? await options.key(header, claims) : options.key
  if (resolved === null || resolved === undefined) throw jwtError("key not found")

  const signature = base64UrlDecode(parts[2]!)
  if (signature === null) throw jwtError("invalid signature encoding")
  const key = await importKey(resolved, alg, header.kid)
  const ok = await crypto.subtle.verify(
    HMAC_ALGS.has(alg) ? { name: "HMAC" } : { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature,
    utf8Bytes(`${parts[0]}.${parts[1]}`),
  )
  if (!ok) throw jwtError("signature mismatch")
  validateClaims(claims, options)
  return { header, claims, token }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : jwtError("verification failed")
}

export async function tryVerifyJwt<C extends JwtClaims = JwtClaims>(
  token: string,
  options: VerifyJwtOptions,
): Promise<VerifyJwtResult<C>> {
  try {
    return { ok: true, data: await verifyJwt<C>(token, options) }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

function tokenFromRequest(req: Request, header: string, cookie: string | undefined): string | null {
  const headerValue = req.headers.get(header)
  if (headerValue !== null) {
    if (header === "authorization") {
      return headerValue.startsWith("Bearer ") ? headerValue.slice(7).trim() || null : null
    }
    return headerValue.trim() || null
  }
  return cookie === undefined ? null : (parseCookies(req.headers.get("cookie"))[cookie] ?? null)
}

function challenge(realm: string): string {
  return `Bearer realm="${quotedHeaderValue(realm)}"`
}

function reject(realm: string): Response {
  return jsonError(401, "unauthorized", { "www-authenticate": challenge(realm) })
}

export function jwt<C extends JwtClaims = JwtClaims>(options: JwtOptions): JwtPlugin<C> {
  validateAlgorithms(options.algorithms)
  const realm = options.realm ?? "api"
  const optional = options.optional === true
  const header = (options.header ?? "authorization").toLowerCase()
  const store = new WeakMap<Request, C>()

  const plugin = definePlugin("jwt", (app) =>
    app.beforeHandle(async (c: { readonly req: Request }) => {
      const token = tokenFromRequest(c.req, header, options.cookie)
      if (token === null) return optional ? undefined : reject(realm)
      try {
        const verified = await verifyJwt<C>(token, options)
        store.set(c.req, verified.claims)
        return undefined
      } catch {
        return optional ? undefined : reject(realm)
      }
    }),
  )
  const instrumented = optional
    ? plugin
    : withRouteAssurance(plugin, {
        id: NIFRA_ASSURANCE.AUTHENTICATED,
        source: "jwt",
        scope: "subsequent",
      })
  return Object.assign(instrumented, {
    claims: (request: Request): C | null => store.get(request) ?? null,
    requireClaims: (request: Request): C => {
      const claims = store.get(request)
      if (claims === undefined) throw reject(realm)
      return claims
    },
  }) as JwtPlugin<C>
}

export function jwk(key: JwtVerificationKey): JwtKeyResolver {
  return (header) => {
    if (typeof key === "object" && !(key instanceof Uint8Array) && !(key instanceof CryptoKey)) {
      if (header.kid !== undefined && key.kid !== undefined && key.kid !== header.kid) return null
    }
    return key
  }
}

function validateJwksUrl(url: URL): void {
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  if (url.protocol !== "https:" && !local) {
    throw new Error("jwks: url must be https unless it targets localhost")
  }
}

async function readTextBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length")
  if (declared !== null && /^(?:0|[1-9]\d*)$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error("jwks: response too large")
  }
  const body = res.body
  if (body === null) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error("jwks: response too large")
      }
      text += decoder.decode(value, { stream: true })
    }
  } catch (err) {
    if (err instanceof Error && err.message === "jwks: response too large") throw err
    throw new Error("jwks: response read failed")
  }
}

async function fetchJwks(
  options: Required<Pick<JwksOptions, "fetch" | "timeoutMs" | "maxBytes">> & { url: URL },
): Promise<readonly JwkKey[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs)
  try {
    const res = await options.fetch(options.url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`jwks: fetch failed with ${res.status}`)
    const text = await readTextBounded(res, options.maxBytes)
    const parsed: unknown = JSON.parse(text)
    if (!isObject(parsed) || !Array.isArray(parsed.keys)) throw new Error("jwks: invalid set")
    return parsed.keys.filter(isObject) as JwkKey[]
  } finally {
    clearTimeout(timer)
  }
}

export function jwks(options: JwksOptions): JwtKeyResolver {
  const url = new URL(String(options.url))
  validateJwksUrl(url)
  const fetcher = options.fetch ?? fetch
  const cacheMs = options.cacheMs ?? 300_000
  const staleMs = options.staleMs ?? cacheMs
  const timeoutMs = options.timeoutMs ?? 5_000
  const maxBytes = options.maxBytes ?? 65_536
  if (!Number.isFinite(cacheMs) || cacheMs < 0)
    throw new Error("jwks: cacheMs must be non-negative")
  if (!Number.isFinite(staleMs) || staleMs < 0)
    throw new Error("jwks: staleMs must be non-negative")
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("jwks: timeoutMs must be positive")
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("jwks: maxBytes must be positive")
  }
  let cached: readonly JwkKey[] = []
  let cachedAt = 0
  let pending: Promise<readonly JwkKey[]> | undefined

  const load = async (): Promise<readonly JwkKey[]> => {
    const now = Date.now()
    if (cached.length > 0 && now - cachedAt < cacheMs) return cached
    pending ??= fetchJwks({ url, fetch: fetcher, timeoutMs, maxBytes }).finally(() => {
      pending = undefined
    })
    try {
      cached = await pending
      cachedAt = Date.now()
      return cached
    } catch (error) {
      if (cached.length > 0 && staleMs > 0 && Date.now() - cachedAt < cacheMs + staleMs) {
        return cached
      }
      throw error
    }
  }

  return async (header) => {
    if (typeof header.kid !== "string" || header.kid === "") return null
    const keys = await load()
    const alg = header.alg as JwtAlgorithm
    return keys.find((key) => key.kid === header.kid && validateJwkForAlg(key, alg, header.kid))
  }
}

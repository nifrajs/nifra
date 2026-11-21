import {
  isAuthenticatedRequest,
  type Middleware,
  sharedResponseCacheBypass,
} from "@nifrajs/core/server"
import { type ChunkReader, concatBytes, replayFrom } from "./_chunks.ts"
import { type MaybePromise, withHeaders } from "./_utils.ts"

export interface CachedResponse {
  readonly status: number
  readonly statusText: string
  readonly headers: readonly [string, string][]
  readonly body: Uint8Array
  readonly expiresAt: number
  readonly storedAt: number
  /** A shared-cache write checked against the final response. Older entries are misses. */
  readonly finalized?: true
}

export interface ResponseCacheStore {
  get(key: string): MaybePromise<CachedResponse | undefined>
  set(key: string, response: CachedResponse): MaybePromise<void>
  delete?(key: string): MaybePromise<void>
}

export interface MemoryResponseCacheOptions {
  /** Maximum entries retained. Default `1000`. Least-recently-used entries are evicted first. */
  readonly maxEntries?: number
  /** Maximum total cached body bytes retained in memory. Default `64 * 1024 * 1024` (64 MiB). */
  readonly maxTotalBytes?: number
  /** Allow in-process cache in production. Off by default because it is per-instance. */
  readonly allowInProduction?: boolean
}

const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024

export class MemoryResponseCache implements ResponseCacheStore {
  private readonly entries = new Map<string, CachedResponse>()
  private readonly maxEntries: number
  private readonly maxTotalBytes: number
  private totalBytes = 0

  constructor(options: MemoryResponseCacheOptions = {}) {
    const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV
    if (options.allowInProduction !== true && env === "production") {
      throw new Error(
        "MemoryResponseCache is per-instance and unsafe in production. Use a shared cache store, " +
          "or pass { allowInProduction: true } for a single-instance deploy.",
      )
    }
    this.maxEntries = options.maxEntries ?? 1000
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("MemoryResponseCache: maxEntries must be a positive integer")
    }
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    if (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < 0) {
      throw new Error("MemoryResponseCache: maxTotalBytes must be a non-negative safe integer")
    }
  }

  get(key: string): CachedResponse | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.delete(key)
      return undefined
    }
    // LRU touch: move accessed entry to the tail so hot entries survive bursts.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, response: CachedResponse): void {
    const size = response.body.byteLength
    if (size > this.maxTotalBytes) {
      this.delete(key)
      return
    }
    this.delete(key)
    while (this.entries.size >= this.maxEntries || this.totalBytes + size > this.maxTotalBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
    this.entries.set(key, response)
    this.totalBytes += size
  }

  delete(key: string): void {
    const existing = this.entries.get(key)
    if (existing === undefined) return
    this.entries.delete(key)
    this.totalBytes -= existing.body.byteLength
  }
}

export interface CacheOptions {
  readonly store: ResponseCacheStore
  /** Maximum time to live in milliseconds; response freshness can shorten it. */
  readonly ttlMs: number
  /** Methods cached. Default `["GET", "HEAD"]`. */
  readonly methods?: readonly string[]
  /** Status predicate. Default: `200` only. */
  readonly status?: (status: number) => boolean
  /** Header names included in the cache key and emitted in `Vary`. */
  readonly vary?: readonly string[]
  /** Custom cache key. Receives the normalized `vary` headers through the request itself. */
  readonly key?: (request: Request) => string
  /** Maximum response bytes to store. Default `1_000_000`. Larger responses pass through. */
  readonly maxBytes?: number
  /** Respect request `Cache-Control: no-cache/no-store`. Default `true`. */
  readonly respectRequestCacheControl?: boolean
  /** Respect response private/no-store/no-cache and max-age/s-maxage freshness. Default `true`.
   * Responses requiring validation bypass this cache, which has no revalidation transport. */
  readonly respectResponseCacheControl?: boolean
  /** Cache responses with `Set-Cookie`. Default `false`. */
  readonly cacheSetCookie?: boolean
  /** Cache responses to requests bearing `Authorization` or `Cookie` even when the response is not
   * explicitly `Cache-Control: public` (or `s-maxage`). Default `false`: a shared cache must not store a
   * personalized response (RFC 9111 §3.5), or it would be replayed to other users. Leave this off unless
   * the cached route is genuinely the same for every caller. */
  readonly cacheAuthenticated?: boolean
  /** Credential headers that make a request private. Defaults to Authorization, Cookie, and x-api-key.
   * A response to a request an authentication stage accepted (or an integration marked with
   * `markAuthenticatedRequest`) is treated as private too, whichever header carried the credential. */
  readonly authenticatedHeaders?: readonly string[]
  /** Response header for cache status. Default `"x-nifra-cache"`; set `false` to disable. */
  readonly cacheStatusHeader?: string | false
}

function parseLength(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined
  return Number(value)
}

function cacheControlHas(headers: Headers, names: readonly string[]): boolean {
  const value = headers.get("cache-control")
  if (value === null) return false
  const parts = value
    .toLowerCase()
    .split(",")
    .map((part) => part.trim().split("=", 1)[0]?.trim())
  return names.some((name) => parts.includes(name))
}

function responseLifetimeMs(headers: Headers, ttlMs: number): number {
  if (cacheControlHas(headers, ["private", "no-store", "no-cache"])) return 0
  const directives = headers.get("cache-control")?.split(",") ?? []
  // This is a shared cache: s-maxage takes precedence over max-age. Ambiguous freshness is stale.
  for (const name of ["s-maxage", "max-age"]) {
    const matches = directives.filter(
      (part) => part.trim().split("=", 1)[0]?.trim().toLowerCase() === name,
    )
    if (matches.length === 0) continue
    if (matches.length !== 1) return 0
    const raw = matches[0]?.slice(matches[0].indexOf("=") + 1).trim() ?? ""
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    const seconds = parseLength(value)
    if (seconds === undefined || !Number.isFinite(seconds)) return 0
    const age = parseLength(headers.get("age")) ?? 0
    return Math.min(ttlMs, Math.max(0, seconds - age) * 1000)
  }
  return ttlMs
}

function appendVary(headers: Headers, vary: readonly string[]): void {
  if (vary.length === 0) return
  const existing = headers
    .get("vary")
    ?.split(",")
    .map((v) => v.trim().toLowerCase())
  const seen = new Set(existing ?? [])
  const additions: string[] = []
  for (const header of vary) {
    const normalized = header.toLowerCase()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      additions.push(header)
    }
  }
  if (additions.length === 0) return
  const current = headers.get("vary")
  headers.set(
    "vary",
    current === null ? additions.join(", ") : `${current}, ${additions.join(", ")}`,
  )
}

function defaultKey(req: Request, vary: readonly string[]): string {
  let key = `${req.method.toUpperCase()} ${req.url}`
  for (const header of vary) key += `\n${header.toLowerCase()}:${req.headers.get(header) ?? ""}`
  return key
}

type ReadBytes =
  | { readonly bytes: Uint8Array; readonly response: Response }
  | { readonly response: Response }

async function readBytesCapped(res: Response, maxBytes: number): Promise<ReadBytes> {
  const body = res.body
  if (body === null) {
    return {
      bytes: new Uint8Array(),
      response: new Response(null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      }),
    }
  }
  const reader = body.getReader() as ChunkReader
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        reader.releaseLock()
        const bytes = concatBytes(chunks, total)
        return {
          bytes,
          response: new Response(bytes.byteLength === 0 ? null : bytes.slice(), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          }),
        }
      }
      if (value === undefined) return { response: replayFrom(res, chunks, reader) }
      total += value.byteLength
      if (total > maxBytes) {
        return { response: replayFrom(res, chunks.concat([value]), reader) }
      }
      chunks.push(value)
    }
  } catch {
    return { response: replayFrom(res, chunks, reader) }
  }
}

function responseVary(headers: Headers): readonly string[] {
  const value = headers.get("vary")
  if (value === null) return []
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "")
}

function responseVaryMatchesKey(headers: Headers, configured: readonly string[]): boolean {
  const declared = responseVary(headers)
  if (declared.includes("*")) return false
  const configuredSet = new Set(configured.map((header) => header.toLowerCase()))
  return declared.every((header) => configuredSet.has(header))
}

function withStatusHeader(
  res: Response,
  header: string | false,
  status: "HIT" | "MISS" | "BYPASS",
  request?: Request,
): Response {
  if (header === false) return res
  return withHeaders(res, (headers) => headers.set(header, status), request)
}

/**
 * Full response cache for small, cacheable responses. Use a shared `store` in production. The
 * middleware honors `Cache-Control` by default, avoids `Set-Cookie`, caps stored bytes, emits `Age`,
 * and keeps `Vary` headers aligned with the cache key.
 */
export function cache(options: CacheOptions): Middleware {
  const { store } = options
  const ttlMs = options.ttlMs
  if (!Number.isInteger(ttlMs) || ttlMs < 1)
    throw new Error("cache: ttlMs must be a positive integer")
  const methods = new Set((options.methods ?? ["GET", "HEAD"]).map((m) => m.toUpperCase()))
  const statusOk = options.status ?? ((status: number) => status === 200)
  const vary = options.vary ?? []
  const keyOf = options.key ?? ((req: Request) => defaultKey(req, vary))
  const maxBytes = options.maxBytes ?? 1_000_000
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new Error("cache: maxBytes must be a non-negative integer")
  }
  const respectRequestCacheControl = options.respectRequestCacheControl !== false
  const respectResponseCacheControl = options.respectResponseCacheControl !== false
  const cacheSetCookie = options.cacheSetCookie === true
  const cacheAuthenticated = options.cacheAuthenticated === true
  const authenticatedHeaders = (
    options.authenticatedHeaders ?? ["authorization", "cookie", "x-api-key"]
  ).map((header) => header.toLowerCase())
  const cacheStatusHeader =
    options.cacheStatusHeader === undefined ? "x-nifra-cache" : options.cacheStatusHeader
  if (cacheStatusHeader !== false && cacheStatusHeader.trim() === "") {
    throw new Error("cache: cacheStatusHeader is empty")
  }
  const hits = new WeakSet<Request>()
  const requestKeys = new WeakMap<Request, string>()
  const pending = new WeakMap<Request, CachedResponse>()
  const hasAuthentication = (req: Request): boolean =>
    isAuthenticatedRequest(req) || authenticatedHeaders.some((header) => req.headers.has(header))
  const responseLifetime = (headers: Headers): number =>
    respectResponseCacheControl ? responseLifetimeMs(headers, ttlMs) : ttlMs
  const bypass = (req: Request): boolean => sharedResponseCacheBypass.get(req)?.(req) === true
  const mayShare = (headers: Headers, req: Request): boolean =>
    !bypass(req) &&
    (cacheSetCookie || !headers.has("set-cookie")) &&
    responseVaryMatchesKey(headers, vary) &&
    (cacheAuthenticated ||
      !hasAuthentication(req) ||
      cacheControlHas(headers, ["public", "s-maxage"]))

  return {
    name: "cache",
    async onRequest(req) {
      if (!methods.has(req.method.toUpperCase())) return undefined
      if (bypass(req)) return undefined
      if (respectRequestCacheControl && cacheControlHas(req.headers, ["no-cache", "no-store"])) {
        return undefined
      }
      const key = keyOf(req)
      requestKeys.set(req, key)
      const entry = await store.get(key)
      if (entry?.finalized !== true) return undefined
      const cachedHeaders = new Headers([...entry.headers])
      // Never replay a personalized entry before route-scoped authentication runs. Public entries
      // remain eligible (and are explicitly marked by their response Cache-Control metadata).
      if (!mayShare(cachedHeaders, req)) return undefined
      const lifetimeMs = responseLifetime(cachedHeaders)
      if (
        lifetimeMs === 0 ||
        Date.now() >= Math.min(entry.expiresAt, entry.storedAt + lifetimeMs)
      ) {
        await store.delete?.(key)
        return undefined
      }
      hits.add(req)
      const headers = cachedHeaders
      const age = parseLength(headers.get("age")) ?? 0
      headers.set(
        "age",
        String(age + Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000))),
      )
      if (cacheStatusHeader !== false) headers.set(cacheStatusHeader, "HIT")
      const body =
        req.method === "HEAD" ||
        entry.status === 204 ||
        entry.status === 205 ||
        entry.status === 304
          ? null
          : entry.body.slice()
      return new Response(body, {
        status: entry.status,
        statusText: entry.statusText,
        headers,
      })
    },
    async onResponse(res, req) {
      if (hits.has(req)) {
        hits.delete(req)
        requestKeys.delete(req)
        return res
      }
      if (!methods.has(req.method.toUpperCase())) return res
      if (!statusOk(res.status)) return res
      if (respectRequestCacheControl && cacheControlHas(req.headers, ["no-store"])) {
        return withStatusHeader(res, cacheStatusHeader, "BYPASS", req)
      }
      const lifetimeMs = responseLifetime(res.headers)
      if (lifetimeMs === 0 || !mayShare(res.headers, req)) {
        return withStatusHeader(res, cacheStatusHeader, "BYPASS", req)
      }
      const declared = parseLength(res.headers.get("content-length"))
      if (declared !== undefined && declared > maxBytes) {
        return withStatusHeader(res, cacheStatusHeader, "BYPASS", req)
      }
      const storedAt = Date.now()
      const captured = await readBytesCapped(res, maxBytes)
      if (!("bytes" in captured)) {
        return withStatusHeader(captured.response, cacheStatusHeader, "BYPASS", req)
      }
      const body = captured.bytes
      const capturedResponse = captured.response
      const expiresAt = storedAt + lifetimeMs
      if (Date.now() >= expiresAt) {
        return withStatusHeader(capturedResponse, cacheStatusHeader, "BYPASS", req)
      }

      const headers = new Headers(capturedResponse.headers)
      if (cacheStatusHeader !== false) headers.delete(cacheStatusHeader)
      appendVary(headers, vary)
      // Snapshot this stage for replay. Later transforms run again on a hit.
      pending.set(req, {
        status: res.status,
        statusText: res.statusText,
        headers: [...headers.entries()],
        body,
        expiresAt,
        storedAt,
      })
      const outgoing = new Headers(capturedResponse.headers)
      appendVary(outgoing, vary)
      return new Response(capturedResponse.body, {
        status: capturedResponse.status,
        statusText: capturedResponse.statusText,
        headers: outgoing,
      })
    },
    async onResponseFinalized(outcome, req) {
      const entry = pending.get(req)
      const key = requestKeys.get(req)
      requestKeys.delete(req)
      if (entry === undefined) return
      pending.delete(req)
      if ("error" in outcome) return
      const { response } = outcome
      const expiresAt = Math.min(
        entry.expiresAt,
        entry.storedAt + responseLifetime(response.headers),
      )
      if (
        response.status !== entry.status ||
        !mayShare(response.headers, req) ||
        Date.now() >= expiresAt
      ) {
        if (cacheStatusHeader !== false) response.headers.set(cacheStatusHeader, "BYPASS")
        return
      }
      await store.set(key ?? keyOf(req), { ...entry, expiresAt, finalized: true })
      if (cacheStatusHeader !== false) response.headers.set(cacheStatusHeader, "MISS")
    },
  }
}

export const responseCache = cache

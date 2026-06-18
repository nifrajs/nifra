import type { Middleware } from "@nifrajs/core"
import type { MaybePromise } from "./_utils.ts"

export interface CachedResponse {
  readonly status: number
  readonly statusText: string
  readonly headers: readonly [string, string][]
  readonly body: Uint8Array
  readonly expiresAt: number
  readonly storedAt: number
}

export interface ResponseCacheStore {
  get(key: string): MaybePromise<CachedResponse | undefined>
  set(key: string, response: CachedResponse): MaybePromise<void>
  delete?(key: string): MaybePromise<void>
}

export interface MemoryResponseCacheOptions {
  /** Maximum entries retained. Default `1000`. Oldest entries are evicted first. */
  readonly maxEntries?: number
  /** Allow in-process cache in production. Off by default because it is per-instance. */
  readonly allowInProduction?: boolean
}

export class MemoryResponseCache implements ResponseCacheStore {
  private readonly entries = new Map<string, CachedResponse>()
  private readonly maxEntries: number

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
  }

  get(key: string): CachedResponse | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  set(key: string, response: CachedResponse): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, response)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }
}

export interface CacheOptions {
  readonly store: ResponseCacheStore
  /** Time to live in milliseconds. */
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
  /** Respect response `Cache-Control: private/no-store`. Default `true`. */
  readonly respectResponseCacheControl?: boolean
  /** Cache responses with `Set-Cookie`. Default `false`. */
  readonly cacheSetCookie?: boolean
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
    .map((part) => part.trim().split("=", 1)[0])
  return names.some((name) => parts.includes(name))
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

async function readBytesCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = res.clone().body
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        const out = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          out.set(chunk, offset)
          offset += chunk.byteLength
        }
        return out
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
}

function withStatusHeader(
  res: Response,
  header: string | false,
  status: "HIT" | "MISS" | "BYPASS",
): Response {
  if (header === false) return res
  const headers = new Headers(res.headers)
  headers.set(header, status)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
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
  const cacheStatusHeader =
    options.cacheStatusHeader === undefined ? "x-nifra-cache" : options.cacheStatusHeader
  if (cacheStatusHeader !== false && cacheStatusHeader.trim() === "") {
    throw new Error("cache: cacheStatusHeader is empty")
  }
  const hits = new WeakSet<Request>()

  return {
    name: "cache",
    async onRequest(req) {
      if (!methods.has(req.method.toUpperCase())) return undefined
      if (respectRequestCacheControl && cacheControlHas(req.headers, ["no-cache", "no-store"])) {
        return undefined
      }
      const key = keyOf(req)
      const entry = await store.get(key)
      if (entry === undefined) return undefined
      if (Date.now() >= entry.expiresAt) {
        await store.delete?.(key)
        return undefined
      }
      hits.add(req)
      const headers = new Headers([...entry.headers])
      headers.set("age", String(Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000))))
      if (cacheStatusHeader !== false) headers.set(cacheStatusHeader, "HIT")
      return new Response(req.method === "HEAD" ? null : entry.body.slice(), {
        status: entry.status,
        statusText: entry.statusText,
        headers,
      })
    },
    async onResponse(res, req) {
      if (hits.has(req)) {
        hits.delete(req)
        return res
      }
      if (!methods.has(req.method.toUpperCase())) return res
      if (!statusOk(res.status)) return res
      if (respectRequestCacheControl && cacheControlHas(req.headers, ["no-store"])) {
        return withStatusHeader(res, cacheStatusHeader, "BYPASS")
      }
      if (respectResponseCacheControl && cacheControlHas(res.headers, ["private", "no-store"])) {
        return withStatusHeader(res, cacheStatusHeader, "BYPASS")
      }
      if (!cacheSetCookie && res.headers.has("set-cookie")) {
        return withStatusHeader(res, cacheStatusHeader, "BYPASS")
      }
      const declared = parseLength(res.headers.get("content-length"))
      if (declared !== undefined && declared > maxBytes) {
        return withStatusHeader(res, cacheStatusHeader, "BYPASS")
      }
      const body = await readBytesCapped(res, maxBytes)
      if (body === null) return withStatusHeader(res, cacheStatusHeader, "BYPASS")

      const headers = new Headers(res.headers)
      headers.delete("age")
      if (cacheStatusHeader !== false) headers.delete(cacheStatusHeader)
      appendVary(headers, vary)
      const now = Date.now()
      await store.set(keyOf(req), {
        status: res.status,
        statusText: res.statusText,
        headers: [...headers.entries()],
        body,
        expiresAt: now + ttlMs,
        storedAt: now,
      })
      const outgoing = new Headers(res.headers)
      appendVary(outgoing, vary)
      if (cacheStatusHeader !== false) outgoing.set(cacheStatusHeader, "MISS")
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: outgoing,
      })
    },
  }
}

export const responseCache = cache

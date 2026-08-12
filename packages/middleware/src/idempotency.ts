import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import { METHODS, type Middleware } from "@nifrajs/core/server"

/**
 * Idempotency keys for unsafe requests - a client retrying a `POST` (dropped connection, impatient
 * tap) with the same `Idempotency-Key` gets the **first** response replayed instead of the side effect
 * running twice (double-charge, double-publish). Runs in `onRequest` (before the handler), so a replay
 * or an in-flight collision short-circuits before any mutation.
 *
 * Pair it with a DB uniqueness constraint - this stops the *retry*, the constraint is the source of
 * truth for genuinely-concurrent distinct requests. Production MUST use a shared {@link IdempotencyStore}
 * (Redis, etc.) so the guarantee holds across instances; {@link MemoryIdempotencyStore} is dev-only.
 */

/** A captured response, replayed verbatim on a retry. Body is base64 (binary-safe + JSON-serializable). */
export interface IdempotencyRecord {
  readonly status: number
  /** Response headers, **excluding `Set-Cookie`** (cookies are session-specific - see {@link idempotency}). */
  readonly headers: ReadonlyArray<readonly [string, string]>
  /** Response body, base64-encoded. */
  readonly body: string
}

export type IdempotencyClaim =
  | { readonly state: "new" }
  | { readonly state: "in_flight" }
  | { readonly state: "replay"; readonly record: IdempotencyRecord }

/**
 * Store backing the idempotency guarantee. Production deploys MUST use a shared store so the key holds
 * across instances; `begin` MUST be **atomic** (e.g. Redis `SET key NX PX lockTtlMs`) or two concurrent
 * retries can both see `"new"`. {@link MemoryIdempotencyStore} is for dev / single-instance only.
 */
export interface IdempotencyStore {
  /**
   * Atomically claim `key`: `"replay"` if a completed response is stored, `"in_flight"` if another
   * request holds the lock, else `"new"` (the caller now owns the lock and must `complete`/`release`).
   * The in-flight lock expires after `lockTtlMs` so a crashed handler can't wedge the key forever.
   */
  begin(key: string, lockTtlMs: number): Promise<IdempotencyClaim>
  /** Store the completed response and release the lock (kept for `ttlMs`). */
  complete(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void>
  /** Release the lock without storing (handler errored / response not cacheable). */
  release(key: string): Promise<void>
}

export interface MemoryIdempotencyStoreOptions {
  /** Allow the in-memory store in production. Off by default - a per-instance store can't dedupe across instances. */
  readonly allowInProduction?: boolean
  /** Maximum retained locks + records. Default `10_000`. */
  readonly maxEntries?: number
  /** Maximum key length in UTF-8 bytes. Default `1024`. */
  readonly maxKeyBytes?: number
}

type Entry =
  | { readonly kind: "lock"; readonly expiresAt: number }
  | { readonly kind: "record"; readonly record: IdempotencyRecord; readonly expiresAt: number }

const KEY_ENCODER = new TextEncoder()

/**
 * Thrown by a store that is full of entries none of which may be discarded. The middleware turns it
 * into a `503` with `retry-after`; a store that can grow (Redis) never raises it.
 */
export class IdempotencyCapacityError extends Error {
  constructor() {
    super("idempotency store is at capacity")
    this.name = "IdempotencyCapacityError"
  }
}

/** In-process store. Refuses to run in production unless explicitly allowed (per-instance ⇒ no cross-instance dedupe). */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>()
  private readonly maxEntries: number
  private readonly maxKeyBytes: number

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    if (options.allowInProduction !== true && process.env.NODE_ENV === "production") {
      throw new Error(
        "MemoryIdempotencyStore is per-instance and can't dedupe across instances in production. " +
          "Use a shared store (e.g. Redis), or pass { allowInProduction: true } for a single-instance deploy.",
      )
    }
    this.maxEntries = options.maxEntries ?? 10_000
    this.maxKeyBytes = options.maxKeyBytes ?? 1024
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1)
      throw new RangeError("MemoryIdempotencyStore: maxEntries must be a positive safe integer")
    if (!Number.isSafeInteger(this.maxKeyBytes) || this.maxKeyBytes < 1)
      throw new RangeError("MemoryIdempotencyStore: maxKeyBytes must be a positive safe integer")
  }

  private validateKey(key: string): void {
    if (KEY_ENCODER.encode(key).byteLength > this.maxKeyBytes)
      throw new RangeError("MemoryIdempotencyStore: key is too large")
  }

  private maintain(now: number): void {
    // Expiry cleanup is incremental so normal requests never scan the full map.
    let checked = 0
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
      if (++checked >= 16) break
    }
  }

  private reserve(key: string, entry: Entry): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      // The incremental sweep only samples, so pay for a full one before declaring the store full.
      const now = Date.now()
      for (const [existing, held] of this.entries) {
        if (held.expiresAt <= now) this.entries.delete(existing)
      }
    }
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      // Refuse rather than evict. Every entry here is either a lock on a request still running or a
      // response another request is entitled to replay, so dropping one to make room hands out
      // exactly the duplicate execution this store exists to prevent - and does it silently, under
      // the load where it is most likely to matter. A 503 is the honest answer; raise `maxEntries`.
      throw new IdempotencyCapacityError()
    }
    this.entries.set(key, entry)
  }

  begin(key: string, lockTtlMs: number): Promise<IdempotencyClaim> {
    this.validateKey(key)
    assertPositiveTtl(lockTtlMs, "lockTtlMs")
    const now = Date.now()
    this.maintain(now)
    const entry = this.entries.get(key)
    if (entry !== undefined && entry.expiresAt > now) {
      return Promise.resolve(
        entry.kind === "record"
          ? { state: "replay", record: entry.record }
          : { state: "in_flight" },
      )
    }
    // Free (or expired): take the lock. Synchronous Map write ⇒ atomic on a single instance.
    this.reserve(key, { kind: "lock", expiresAt: now + lockTtlMs })
    return Promise.resolve({ state: "new" })
  }

  complete(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void> {
    this.validateKey(key)
    assertPositiveTtl(ttlMs, "ttlMs")
    this.reserve(key, { kind: "record", record, expiresAt: Date.now() + ttlMs })
    return Promise.resolve()
  }

  release(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (entry !== undefined && entry.kind === "lock") this.entries.delete(key)
    return Promise.resolve()
  }
}

export interface IdempotencyOptions {
  /** Where claims + cached responses live. `MemoryIdempotencyStore` for dev; a shared store in production. */
  readonly store: IdempotencyStore
  /** Header carrying the key. Default `"idempotency-key"`. */
  readonly header?: string
  /** Methods the guard applies to. Default `["POST", "PUT", "PATCH", "DELETE"]` (unsafe methods). */
  readonly methods?: readonly string[]
  /** How long a completed response is replayable, in ms. Default 24h. */
  readonly ttlMs?: number
  /** How long the in-flight lock survives a crashed handler, in ms. Default 60s. */
  readonly lockTtlMs?: number
  /** Max response bytes to cache. A larger response is returned but **not** stored. Default 1 MiB. */
  readonly maxBytes?: number
  /** Whether a response should be cached for replay. Default: status `< 500` (don't replay transient 5xx). */
  readonly shouldCache?: (response: Response) => boolean
  /**
   * Derive the store key from the request. Default: the `header` value scoped by method + path **and
   * by a digest of the caller's credentials** (see `principalHeaders`), so neither a different
   * endpoint nor a different caller can collide on one key. Return `null`/`""` to skip dedupe for
   * this request.
   *
   * Supplying your own replaces that scoping entirely - a custom key MUST fold in the principal
   * itself (e.g. `` `${userId}:${req.headers.get("idempotency-key")}` ``), or one user can replay
   * another's stored response by guessing their key.
   */
  readonly key?: (req: Request, header: string) => string | null | Promise<string | null>
  /**
   * Headers whose values identify the caller. Their digest scopes the default key, so the same
   * `Idempotency-Key` from two callers addresses two entries and neither can read the other's cached
   * response. Defaults to Authorization, Cookie, and x-api-key. Only a digest is stored - a raw
   * credential must never become a store key, which would put it in front of every Redis `KEYS` dump
   * and slow-log line. Ignored when `key` is supplied.
   *
   * The digest covers the header value verbatim, so anything that varies between two requests from the
   * same caller - a rotated bearer token, an analytics cookie appended mid-session - lands on a fresh
   * key and the retry executes again. Narrow the list (or supply `key`) when the app has a stable
   * principal id to scope by; that is strictly better than digesting a whole `Cookie` header.
   */
  readonly principalHeaders?: readonly string[]
}

const DEFAULT_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const
const DAY_MS = 24 * 60 * 60 * 1000

function assertPositiveTtl(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`idempotency: ${name} must be a finite positive safe integer`)
  }
}

const toBase64 = (bytes: Uint8Array): string => {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const fromBase64 = (value: string): Uint8Array => {
  const bin = atob(value)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// 204/205/304 (and an empty body) must be constructed with a `null` body or the Response ctor throws.
const bodyFor = (bytes: Uint8Array): Uint8Array | null => (bytes.byteLength === 0 ? null : bytes)

interface ByteReader {
  read(): Promise<
    | { readonly done: true; readonly value?: undefined }
    | { readonly done: false; readonly value: Uint8Array }
  >
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function parseLength(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined
  return Number(value)
}

function responseWithBody(
  res: Response,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
): Response {
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

function replayBufferedBody(
  reader: ByteReader,
  buffered: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  let index = 0
  let released = false
  const release = (): void => {
    if (!released) {
      released = true
      reader.releaseLock()
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < buffered.length) {
        controller.enqueue(buffered[index]!)
        index += 1
        return
      }
      try {
        const { done, value } = await reader.read()
        if (done) {
          release()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (err) {
        release()
        controller.error(err)
      }
    },
    cancel(reason) {
      return reader.cancel(reason).finally(release)
    },
  })
}

async function captureBody(
  res: Response,
  maxBytes: number,
): Promise<
  { readonly bytes: Uint8Array; readonly response: Response } | { readonly response: Response }
> {
  const declared = parseLength(res.headers.get("content-length"))
  if (declared !== undefined && declared > maxBytes) return { response: res }
  const body = res.body
  if (body === null) return { bytes: new Uint8Array(), response: responseWithBody(res, null) }

  const reader: ByteReader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        reader.releaseLock()
        const bytes = concat(chunks, total)
        return { bytes, response: responseWithBody(res, bodyFor(bytes)) }
      }
      chunks.push(value)
      total += value.byteLength
      if (total > maxBytes) {
        return { response: responseWithBody(res, replayBufferedBody(reader, chunks)) }
      }
    }
  } catch (err) {
    reader.releaseLock()
    throw err
  }
}

function replay(record: IdempotencyRecord): Response {
  const headers = new Headers(record.headers as Array<[string, string]>)
  headers.set("idempotent-replayed", "true")
  return new Response(bodyFor(fromBase64(record.body)), { status: record.status, headers })
}

const DEFAULT_PRINCIPAL_HEADERS = ["authorization", "cookie", "x-api-key"] as const

/** SHA-256 of the caller's credential headers, base64url. Only the digest ever becomes part of a store
 * key: a raw `Authorization` value used as a key would be printed by every Redis `KEYS` dump, slow-log
 * line, and store-side metric that treats keys as non-sensitive. */
async function principalDigest(req: Request, headers: readonly string[]): Promise<string | null> {
  let material = ""
  for (const name of headers) {
    const value = req.headers.get(name)
    // The header name is part of the material so `authorization: x` and `x-api-key: x` can't collide.
    if (value !== null) material += `${name}:${value}\n`
  }
  if (material === "") return null // no credentials presented - an anonymous caller
  const hash = await crypto.subtle.digest("SHA-256", KEY_ENCODER.encode(material))
  return toBase64(new Uint8Array(hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * The default store key: the `header` value scoped by method + path (so the same key on a different
 * endpoint can't collide) **and by a digest of the caller's credentials** (so one caller can't replay
 * another's stored response by presenting their key). `null` when no key header is present - no dedupe.
 */
function defaultIdempotencyKey(
  req: Request,
  header: string,
  principalHeaders: readonly string[],
): Promise<string | null> | null {
  const raw = req.headers.get(header)
  if (raw === null || raw === "") return null
  const scope = `${req.method.toUpperCase()} ${new URL(req.url).pathname}`
  return principalDigest(req, principalHeaders).then(
    (principal) => `${scope}\n${principal ?? "anon"}\n${raw}`,
  )
}

/**
 * Idempotency-key middleware. Apply with `app.use(idempotency({ store }))`.
 *
 * The store key is scoped by method + path **and** by a digest of the caller's credential headers, so
 * a key one caller chose addresses only that caller's entry - presenting someone else's key replays
 * nothing. See `principalHeaders`; a custom `key` replaces that scoping and must do it itself.
 *
 * **`Set-Cookie` is intentionally not cached or replayed** - a cookie set on the first request is
 * session-specific, so replaying it to a different caller (key collision or abuse) would leak/fixate a
 * session. Cache the body + status + the rest of the headers; let auth cookies re-issue per request.
 *
 * Caching buffers the response body, so apply this to JSON/API routes, not streaming SSR responses.
 */
export function idempotency(options: IdempotencyOptions): Middleware {
  const { store } = options
  const header = (options.header ?? "idempotency-key").toLowerCase()
  const methods = new Set((options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()))
  const ttlMs = options.ttlMs ?? DAY_MS
  const lockTtlMs = options.lockTtlMs ?? 60_000
  const maxBytes = options.maxBytes ?? 1024 * 1024
  assertPositiveTtl(ttlMs, "ttlMs")
  assertPositiveTtl(lockTtlMs, "lockTtlMs")
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("idempotency: maxBytes must be a non-negative integer")
  }
  const shouldCache = options.shouldCache ?? ((res: Response) => res.status < 500)
  const principalHeaders = (options.principalHeaders ?? DEFAULT_PRINCIPAL_HEADERS).map((name) =>
    name.toLowerCase(),
  )
  const custom = options.key
  const keyOf =
    custom === undefined
      ? (req: Request): Promise<string | null> | null =>
          defaultIdempotencyKey(req, header, principalHeaders)
      : (req: Request): string | null | Promise<string | null> => custom(req, header)
  const claimed = new WeakMap<Request, string>()

  const middleware: Middleware = {
    name: "idempotency",
    async onRequest(req) {
      if (!methods.has(req.method.toUpperCase())) return undefined
      const key = await keyOf(req)
      if (key === null || key === "") return undefined // opt-in per request - no key ⇒ no dedupe
      let claim: IdempotencyClaim
      try {
        claim = await store.begin(key, lockTtlMs)
      } catch (err) {
        // A full store can't tell a first request from a retry, and guessing either way is wrong:
        // serving the request risks a duplicate side effect, replaying nothing risks losing one. Say
        // so with a 503 the client is expected to retry, rather than a 500 that reads as a bug.
        if (!(err instanceof IdempotencyCapacityError)) throw err
        return new Response(JSON.stringify({ ok: false, error: "idempotency_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "1" },
        })
      }
      if (claim.state === "replay") return replay(claim.record)
      if (claim.state === "in_flight") {
        return new Response(JSON.stringify({ ok: false, error: "idempotency_in_progress" }), {
          status: 409,
          headers: {
            "content-type": "application/json",
            "retry-after": String(Math.ceil(lockTtlMs / 1000)),
          },
        })
      }
      claimed.set(req, key)
      return undefined
    },
    async onResponse(res, req) {
      const key = claimed.get(req)
      if (key === undefined) return res // not a claimed request (safe method / no key / a replay)
      claimed.delete(req)
      if (!shouldCache(res)) {
        await store.release(key)
        return res
      }
      // Buffer the body (consumes `res`), so a fresh Response is returned in its place.
      let captured: Awaited<ReturnType<typeof captureBody>>
      try {
        captured = await captureBody(res, maxBytes)
      } catch (err) {
        await store.release(key)
        throw err
      }
      if (!("bytes" in captured)) {
        await store.release(key) // too large to store - return it, but don't cache
        return captured.response
      }
      const bytes = captured.bytes
      const headers = [...captured.response.headers].filter(([name]) => name !== "set-cookie")
      await store.complete(key, { status: res.status, headers, body: toBase64(bytes) }, ttlMs)
      return captured.response
    },
  }
  return withRouteAssurance(middleware, {
    id: NIFRA_ASSURANCE.IDEMPOTENCY_KEY,
    source: "idempotency",
    scope: "global",
    methods: METHODS.filter((method) => methods.has(method)),
  })
}

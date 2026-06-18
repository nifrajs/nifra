import type { Middleware } from "@nifrajs/core"

/**
 * Idempotency keys for unsafe requests — a client retrying a `POST` (dropped connection, impatient
 * tap) with the same `Idempotency-Key` gets the **first** response replayed instead of the side effect
 * running twice (double-charge, double-publish). Runs in `onRequest` (before the handler), so a replay
 * or an in-flight collision short-circuits before any mutation.
 *
 * Pair it with a DB uniqueness constraint — this stops the *retry*, the constraint is the source of
 * truth for genuinely-concurrent distinct requests. Production MUST use a shared {@link IdempotencyStore}
 * (Redis, etc.) so the guarantee holds across instances; {@link MemoryIdempotencyStore} is dev-only.
 */

/** A captured response, replayed verbatim on a retry. Body is base64 (binary-safe + JSON-serializable). */
export interface IdempotencyRecord {
  readonly status: number
  /** Response headers, **excluding `Set-Cookie`** (cookies are session-specific — see {@link idempotency}). */
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
  /** Allow the in-memory store in production. Off by default — a per-instance store can't dedupe across instances. */
  readonly allowInProduction?: boolean
}

type Entry =
  | { readonly kind: "lock"; readonly expiresAt: number }
  | { readonly kind: "record"; readonly record: IdempotencyRecord; readonly expiresAt: number }

/** In-process store. Refuses to run in production unless explicitly allowed (per-instance ⇒ no cross-instance dedupe). */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>()

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    if (options.allowInProduction !== true && process.env.NODE_ENV === "production") {
      throw new Error(
        "MemoryIdempotencyStore is per-instance and can't dedupe across instances in production. " +
          "Use a shared store (e.g. Redis), or pass { allowInProduction: true } for a single-instance deploy.",
      )
    }
  }

  begin(key: string, lockTtlMs: number): Promise<IdempotencyClaim> {
    const now = Date.now()
    const entry = this.entries.get(key)
    if (entry !== undefined && entry.expiresAt > now) {
      return Promise.resolve(
        entry.kind === "record"
          ? { state: "replay", record: entry.record }
          : { state: "in_flight" },
      )
    }
    // Free (or expired): take the lock. Synchronous Map write ⇒ atomic on a single instance.
    this.entries.set(key, { kind: "lock", expiresAt: now + lockTtlMs })
    return Promise.resolve({ state: "new" })
  }

  complete(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void> {
    this.entries.set(key, { kind: "record", record, expiresAt: Date.now() + ttlMs })
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
}

const DEFAULT_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const
const DAY_MS = 24 * 60 * 60 * 1000

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

/**
 * Idempotency-key middleware. Apply with `app.use(idempotency({ store }))`.
 *
 * **`Set-Cookie` is intentionally not cached or replayed** — a cookie set on the first request is
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
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new Error("idempotency: maxBytes must be a non-negative integer")
  }
  const shouldCache = options.shouldCache ?? ((res: Response) => res.status < 500)
  const claimed = new WeakMap<Request, string>()

  return {
    name: "idempotency",
    async onRequest(req) {
      if (!methods.has(req.method)) return undefined
      const key = req.headers.get(header)
      if (key === null || key === "") return undefined // opt-in per request — no key ⇒ no dedupe
      const claim = await store.begin(key, lockTtlMs)
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
        await store.release(key) // too large to store — return it, but don't cache
        return captured.response
      }
      const bytes = captured.bytes
      const headers = [...captured.response.headers].filter(([name]) => name !== "set-cookie")
      await store.complete(key, { status: res.status, headers, body: toBase64(bytes) }, ttlMs)
      return captured.response
    },
  }
}

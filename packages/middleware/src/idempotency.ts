import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import {
  beforeHandler,
  defineIdentityPlugin,
  type IdentityPlugin,
  isAuthenticatedRequest,
  METHODS,
  type Middleware,
  replacedRequestOf,
} from "@nifrajs/core/server"

/**
 * Idempotency keys for unsafe requests - a client retrying a `POST` (dropped connection, impatient
 * tap) with the same `Idempotency-Key` gets the **first** response replayed instead of the side effect
 * running twice (double-charge, double-publish). The key is claimed in `onRequest`, so an in-flight
 * collision short-circuits before any mutation; a replay waits until just before the handler, after
 * the route's authentication, validation and every guard - registered before or after this
 * middleware - accept the retry again, so a credential revoked since the first request gets the
 * route's current answer, not the stored response. It covers routes declared after it; installing it
 * after one throws. A request no covered route handles (a mounted app, an earlier hook's answer) is
 * not deduplicated: its key is released.
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
  /**
   * Set on every record this middleware writes: the response came from a covered route, so a retry is
   * replayed just before that route's handler, after its authentication, validation and guards accept
   * it again. A record without it is refused: its original route admission cannot be established.
   */
  readonly recheck?: boolean
}

export type IdempotencyClaim =
  | { readonly state: "new"; readonly reservation: string }
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
  /** Store the completed response only when `reservation` still owns the lock (kept for `ttlMs`). */
  complete(
    key: string,
    reservation: string,
    record: IdempotencyRecord,
    ttlMs: number,
  ): Promise<boolean>
  /** Release only the lock owned by `reservation` (handler errored / response not cacheable). */
  release(key: string, reservation: string): Promise<boolean>
  /** Extend a still-owned pending lease atomically; false means ownership was lost.
   * Without this, pending reservations use at least the replay retention TTL. */
  renew?(key: string, reservation: string, lockTtlMs: number): Promise<boolean>
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
  | { readonly kind: "lock"; readonly reservation: string; readonly expiresAt: number }
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
    const reservation = crypto.randomUUID()
    this.reserve(key, { kind: "lock", reservation, expiresAt: now + lockTtlMs })
    return Promise.resolve({ state: "new", reservation })
  }

  complete(
    key: string,
    reservation: string,
    record: IdempotencyRecord,
    ttlMs: number,
  ): Promise<boolean> {
    this.validateKey(key)
    assertPositiveTtl(ttlMs, "ttlMs")
    const entry = this.entries.get(key)
    if (entry === undefined || entry.kind !== "lock" || entry.reservation !== reservation) {
      return Promise.resolve(false)
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return Promise.resolve(false)
    }
    this.entries.set(key, { kind: "record", record, expiresAt: Date.now() + ttlMs })
    return Promise.resolve(true)
  }

  release(key: string, reservation: string): Promise<boolean> {
    const entry = this.entries.get(key)
    if (entry === undefined || entry.kind !== "lock" || entry.reservation !== reservation) {
      return Promise.resolve(false)
    }
    this.entries.delete(key)
    return Promise.resolve(true)
  }

  renew(key: string, reservation: string, lockTtlMs: number): Promise<boolean> {
    assertPositiveTtl(lockTtlMs, "lockTtlMs")
    const entry = this.entries.get(key)
    const now = Date.now()
    if (entry?.kind !== "lock" || entry.reservation !== reservation || entry.expiresAt <= now) {
      return Promise.resolve(false)
    }
    this.entries.set(key, { ...entry, expiresAt: now + lockTtlMs })
    return Promise.resolve(true)
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
  /** Pending lease, renewed while work runs (for up to `ttlMs`) when the store supports `renew`.
   * Default 60s. Stores without renewal reserve for at least `ttlMs` instead. */
  readonly lockTtlMs?: number
  /** Max response bytes to capture. Larger cacheable responses retain a fixed terminal replay error so a
   * retry cannot repeat their effects. That small control record is independent of this cap. Default 1 MiB. */
  readonly maxBytes?: number
  /**
   * Whether a response should be cached for replay. Default: any status below 500 except 401, 403,
   * 408, 409, 425, and 429, and the request rejections 400, 404, 405, 413, 414, 415, 422 and 431.
   * Like a transient 5xx, those say the operation did not run: replaying one would refuse every
   * retry under that key until it expired, and storing a rejection lets a caller fill the store
   * with keys sent to a route that does not exist. A handler that answers 400 or 422 after a side
   * effect should supply its own predicate.
   */
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
   *
   * A request that carries none of these headers is keyed as anonymous. If an authentication stage
   * then accepts it (a credential in another header), its response is not stored: under the
   * anonymous key any caller presenting the same `Idempotency-Key` would be replayed it. Add that
   * header here to dedupe such requests.
   */
  readonly principalHeaders?: readonly string[]
}

const DEFAULT_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const
const NOT_THE_OPERATIONS_ANSWER = new Set([
  400, 401, 403, 404, 405, 408, 409, 413, 414, 415, 422, 425, 429, 431,
])
const DAY_MS = 24 * 60 * 60 * 1000
// A stalled renewal must not admit another execution through the same store in this process.
const ACTIVE = new WeakMap<IdempotencyStore, Set<string>>()

function terminalRecord(error: string, status: number): IdempotencyRecord {
  return {
    status,
    headers: [["content-type", "application/json"]],
    body: toBase64(KEY_ENCODER.encode(JSON.stringify({ ok: false, error }))),
    recheck: true,
  }
}

const reservationLost = (): Response =>
  Response.json(
    { ok: false, error: "idempotency_reservation_lost" },
    { status: 503, headers: { "retry-after": "1" } },
  )

function discardResponse(response: Response): void {
  // No caller will consume this response after losing ownership; cancellation must not stall on a tee.
  void response.body?.cancel().catch(() => {})
}

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
  const safeBody = body instanceof Uint8Array ? body.slice() : body
  return new Response(safeBody, {
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
  const body = bodyFor(fromBase64(record.body))
  return new Response(body === null ? null : body.slice(), { status: record.status, headers })
}

/** The request `onRequest` recorded in `map`, walking back past a later hook's replacement of it
 * (methodOverride, a transport codec). */
function recordedRequest<T>(
  map: WeakMap<Request, T>,
  req: Request,
): readonly [Request, T] | undefined {
  for (let current: Request | undefined = req; current !== undefined; ) {
    const found = map.get(current)
    if (found !== undefined) return [current, found]
    current = replacedRequestOf(current)
  }
  return undefined
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
 * The key is not bound to the request body: a key reused with a different body replays the first
 * answer. A route that needs that check declares `schema.idempotency`, which fingerprints the request
 * and refuses a mismatched reuse with 409.
 *
 * Caching buffers the response body, so apply this to JSON/API routes, not streaming SSR responses.
 */
export function idempotency(options: IdempotencyOptions): IdentityPlugin {
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
  const shouldCache =
    options.shouldCache ??
    ((res: Response) => res.status < 500 && !NOT_THE_OPERATIONS_ANSWER.has(res.status))
  const principalHeaders = (options.principalHeaders ?? DEFAULT_PRINCIPAL_HEADERS).map((name) =>
    name.toLowerCase(),
  )
  const custom = options.key
  const keyOf =
    custom === undefined
      ? (req: Request): Promise<string | null> | null =>
          defaultIdempotencyKey(req, header, principalHeaders)
      : (req: Request): string | null | Promise<string | null> => custom(req, header)
  let active = ACTIVE.get(store)
  if (active === undefined) {
    active = new Set()
    ACTIVE.set(store, active)
  }
  const activeKeys = active
  interface Claim {
    readonly key: string
    readonly reservation: string
    readonly anonymous: boolean
    lost: boolean
    heartbeat?: ReturnType<typeof setInterval>
    renewing?: Promise<void>
  }
  const claimed = new WeakMap<Request, Claim>()
  const stop = (claim: Claim): void => {
    if (claim.heartbeat !== undefined) clearInterval(claim.heartbeat)
  }
  const complete = async (claim: Claim, record: IdempotencyRecord): Promise<boolean> => {
    stop(claim)
    await claim.renewing
    return !claim.lost && (await store.complete(claim.key, claim.reservation, record, ttlMs))
  }
  // Replays held for `beforeHandle`, and fresh claims every guard on a covered route admitted.
  const deferred = new WeakMap<Request, IdempotencyRecord>()
  const rechecked = new WeakSet<Request>()

  const middleware: Middleware = {
    async onRequest(req) {
      if (!methods.has(req.method.toUpperCase())) return undefined
      const key = await keyOf(req)
      if (key === null || key === "") return undefined // opt-in per request - no key ⇒ no dedupe
      const inFlight = (): Response =>
        Response.json(
          { ok: false, error: "idempotency_in_progress" },
          { status: 409, headers: { "retry-after": String(Math.ceil(lockTtlMs / 1000)) } },
        )
      if (activeKeys.has(key)) return inFlight()
      let claim: IdempotencyClaim
      try {
        claim = await store.begin(
          key,
          store.renew === undefined ? Math.max(ttlMs, lockTtlMs) : lockTtlMs,
        )
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
      if (claim.state === "replay") {
        if (claim.record.recheck !== true)
          return Response.json(
            { ok: false, error: "idempotency_requires_route_guard" },
            { status: 503 },
          )
        deferred.set(req, claim.record)
        return undefined
      }
      if (claim.state === "in_flight") {
        return inFlight()
      }
      if (claim.state !== "new") return undefined
      const anonymous =
        custom === undefined && principalHeaders.every((name) => req.headers.get(name) === null)
      const held: Claim = { key, reservation: claim.reservation, anonymous, lost: false }
      activeKeys.add(key)
      claimed.set(req, held)
      if (store.renew !== undefined) {
        const renew = store.renew.bind(store)
        // Renewal ends with the replay retention: a handler that never settles keeps this process's
        // fence, but no longer holds the key for every instance, or writes to the store, forever.
        const renewUntil = Date.now() + ttlMs
        held.heartbeat = setInterval(
          () => {
            if (Date.now() >= renewUntil) {
              stop(held)
              return
            }
            if (held.renewing !== undefined || held.lost) return
            held.renewing = Promise.resolve()
              .then(() => renew(key, held.reservation, lockTtlMs))
              .then(
                (owned) => {
                  if (!owned) held.lost = true
                },
                () => {
                  held.lost = true
                }, // A store outage cannot prove continued ownership.
              )
              .finally(() => {
                delete held.renewing
              })
          },
          Math.max(1, Math.floor(lockTtlMs / 3)),
        )
        // A pending lease should not keep a server that is otherwise stopped alive.
        held.heartbeat.unref?.()
      }
      return undefined
    },
    // Runs after every guard on the route, whichever side of this middleware it was registered on.
    beforeHandle: beforeHandler((context) => {
      // Authentication, validation and every guard have accepted this retry; only now is the stored
      // answer its own.
      const held = recordedRequest(deferred, context.req)
      if (held !== undefined) {
        deferred.delete(held[0])
        return replay(held[1])
      }
      const fresh = recordedRequest(claimed, context.req)
      if (fresh !== undefined) rechecked.add(fresh[0])
      return undefined
    }),
    async onResponse(res, req) {
      const found = recordedRequest(claimed, req)
      if (found === undefined) return res // not a claimed request
      const [claimedReq, claim] = found
      claimed.delete(claimedReq)
      try {
        await claim.renewing
        if (claim.lost) {
          discardResponse(res)
          return reservationLost()
        }
        // Without `rechecked` no covered route ran: a guard refused it, or a mounted app or an earlier
        // hook answered. Nothing deduplicated began, and its answer could never be replayed.
        if (
          !rechecked.has(claimedReq) ||
          !shouldCache(res) ||
          (claim.anonymous && (isAuthenticatedRequest(req) || isAuthenticatedRequest(claimedReq)))
        ) {
          stop(claim)
          await claim.renewing
          await store.release(claim.key, claim.reservation)
          return res
        }
        // Buffer the body (consumes `res`), so a fresh Response is returned in its place.
        let captured: Awaited<ReturnType<typeof captureBody>>
        try {
          captured = await captureBody(res, maxBytes)
        } catch (err) {
          await complete(claim, terminalRecord("idempotency_response_unavailable", 500))
          throw err
        }
        if (!("bytes" in captured)) {
          const completed = await complete(
            claim,
            terminalRecord("idempotency_response_too_large", 507),
          )
          if (!completed) {
            discardResponse(captured.response)
            return reservationLost()
          }
          return captured.response
        }
        const bytes = captured.bytes
        const headers = [...captured.response.headers].filter(([name]) => name !== "set-cookie")
        const completed = await complete(claim, {
          status: res.status,
          headers,
          body: toBase64(bytes),
          recheck: true,
        })
        if (!completed) {
          discardResponse(captured.response)
          return reservationLost()
        }
        return captured.response
      } finally {
        stop(claim)
        activeKeys.delete(claim.key)
      }
    },
    async onResponseFinalized(_outcome, req) {
      const found = recordedRequest(claimed, req)
      if (found === undefined) return
      const [original, claim] = found
      claimed.delete(original)
      stop(claim)
      try {
        await claim.renewing
        if (!rechecked.has(original)) {
          await store.release(claim.key, claim.reservation)
          return
        }
        // An earlier response transform failed, so there is no safe response to replay or reason to
        // repeat work. Preserve a terminal outcome rather than releasing the operation's reservation.
        await complete(claim, terminalRecord("idempotency_response_unavailable", 500))
      } finally {
        activeKeys.delete(claim.key)
      }
    },
  }
  const plugin = defineIdentityPlugin("idempotency", (app) => {
    if (app.routes().some((route) => methods.has(route.method))) {
      throw new Error("idempotency must be installed before the routes it protects")
    }
    return app.use(middleware)
  })
  return withRouteAssurance(plugin, {
    id: NIFRA_ASSURANCE.IDEMPOTENCY_KEY,
    source: "idempotency",
    scope: "subsequent",
    methods: METHODS.filter((method) => methods.has(method)),
  })
}

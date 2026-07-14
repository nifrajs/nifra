/**
 * Idempotency primitive. A mutating route can declare `schema.idempotency`; the server then dedupes
 * on an `Idempotency-Key` header: the first request runs and its response is stored, and a retry with
 * the same key replays the stored response byte-for-byte without re-running the handler. A retry that
 * reuses a key with a *different* request body is rejected (409) — a key binds to one request.
 *
 * This module is the runtime-neutral core: the store interface, an in-memory store, the request
 * fingerprint, and response (de)serialization. The server owns the request-path lane that reads the
 * body, consults the store, and captures the response. All logic here is pure/injectable so it is
 * unit-tested without a server. A durable store (cross-restart) implements the same interface.
 */

/** Whether a route's idempotency is satisfied by an in-process store or a durable (cross-restart) one. */
export type IdempotencyScope = "request" | "durable"

/** Default retention for a stored idempotent response: 24 hours. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 86_400_000

/** Canonical request header carrying the client-chosen idempotency key. */
export const DEFAULT_IDEMPOTENCY_HEADER = "idempotency-key"

/** Header stamped on a replayed response so clients/proxies can tell a replay from a fresh run. */
export const IDEMPOTENT_REPLAY_HEADER = "x-nifra-idempotent-replay"

const KEY_MAX_LENGTH = 255

// A replay is a new HTTP exchange, not a byte-for-byte resurrection of connection state. Session
// setters and hop-by-hop headers belong only to the winning response. Filter on both write and read:
// durable stores may still contain records created by an older Nifra version.
const REPLAY_UNSAFE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "authentication-info",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authentication-info",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function replaySafeHeaders(
  headers: Iterable<readonly [string, string]>,
): readonly (readonly [string, string])[] {
  const safe: Array<readonly [string, string]> = []
  for (const [name, value] of headers) {
    if (!REPLAY_UNSAFE_RESPONSE_HEADERS.has(name.toLowerCase())) safe.push([name, value])
  }
  return safe
}

/** A serialized response held by a store. `body` is base64 so binary payloads round-trip intact. */
export interface StoredResponse {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  /** Base64-encoded response body; `""` when the response had no body. */
  readonly body: string
}

/**
 * Outcome of reserving a key. `new` → the caller runs the handler and later calls {@link
 * IdempotencyStore.complete}. `replay` → return the stored response, handler never runs. `mismatch`
 * → same key, different request fingerprint (client bug) → 409. `in-flight` → the key is reserved but
 * not yet completed (a concurrent duplicate) → 409 + Retry-After.
 */
export type IdempotencyBeginResult =
  | { readonly state: "new"; readonly reservation: string }
  | { readonly state: "replay"; readonly response: StoredResponse }
  | { readonly state: "mismatch" }
  | { readonly state: "in-flight" }
  | { readonly state: "capacity" }

/** Namespaces isolate the same client key across tenants/subjects without putting identity in a header. */
export interface IdempotencyEntryKey {
  readonly namespace: string
  readonly key: string
}

export interface IdempotencyBeginInput extends IdempotencyEntryKey {
  readonly fingerprint: string
  readonly ttlMs: number
}

export interface IdempotencyCompletionInput extends IdempotencyEntryKey {
  /** Opaque ownership token returned by `begin(state:"new")`. */
  readonly reservation: string
  readonly response: StoredResponse
}

export interface IdempotencyAbandonInput extends IdempotencyEntryKey {
  /** Opaque ownership token returned by `begin(state:"new")`. */
  readonly reservation: string
}

/**
 * Storage seam for idempotent responses. `begin` MUST be atomic: for one key, exactly one concurrent
 * caller sees `new`; the rest see `in-flight` (or `replay` once completed). The in-memory store gets
 * this free from the single-threaded event loop; a durable store uses an atomic insert.
 */
export interface IdempotencyStore {
  /**
   * An honest durability marker. Omit/`memory` for process-local stores; a route declaring
   * `scope: "durable"` rejects anything other than `durable` at registration.
   */
  readonly durability?: "memory" | "durable"
  /** Reserve one namespaced key. Exactly one concurrent caller may receive `new`. */
  begin(input: IdempotencyBeginInput): IdempotencyBeginResult | Promise<IdempotencyBeginResult>
  /**
   * Persist the final response only when `reservation` still owns the key. Returns false for a stale
   * completion (for example after expiry + re-reservation), which prevents an older request from
   * overwriting a newer result.
   */
  complete(input: IdempotencyCompletionInput): boolean | Promise<boolean>
  /** Release only the pending reservation owned by `reservation`. */
  abandon(input: IdempotencyAbandonInput): boolean | Promise<boolean>
}

/** A key must be a non-empty, bounded, control-char-free token. Fail closed on anything else. */
export function validIdempotencyKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > KEY_MAX_LENGTH) return false
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i)
    if (code < 33 || code > 126) return false
  }
  return true
}

/** Namespace values are server-resolved, bounded opaque tokens (normally a tenant/subject hash). */
export function validIdempotencyNamespace(namespace: string): boolean {
  return validIdempotencyKey(namespace)
}

const encoder = new TextEncoder()

/**
 * SHA-256 fingerprint binding a key to one request: method, path (+ query), and the raw body bytes.
 * A collision-resistant hash matters — a weak hash would let a crafted body replay another's response.
 */
export async function computeIdempotencyFingerprint(
  method: string,
  path: string,
  body: Uint8Array,
  contentType = "",
): Promise<string> {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  const head = encoder.encode(`${method.toUpperCase()}\n${path}\n${mediaType}\n`)
  const material = new Uint8Array(head.length + body.length)
  material.set(head, 0)
  material.set(body, head.length)
  const digest = await crypto.subtle.digest("SHA-256", material)
  const bytes = new Uint8Array(digest)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] as number).toString(16).padStart(2, "0")
  return hex
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${entries.join(",")}}`
  }
  throw new TypeError("unsupported JSON value")
}

/** Canonicalize JSON bodies so whitespace/property-order retries bind to the same semantic request. */
export function canonicalizeIdempotencyBody(
  body: Uint8Array,
  contentType: string | null,
): Uint8Array {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) return body
  try {
    return encoder.encode(canonicalJson(JSON.parse(new TextDecoder().decode(body))))
  } catch {
    // Invalid JSON is rejected by the validation/body lane. Preserve its raw bytes for a stable
    // fingerprint until that rejection releases the reservation.
    return body
  }
}

const BASE64_CHUNK = 0x8000

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function base64DecodedLength(value: string): number {
  if (value === "") return 0
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError("idempotency: corrupt stored response body")
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return (value.length / 4) * 3 - padding
}

export class IdempotencyResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`idempotency response exceeds the ${maxBytes}-byte storage bound`)
    this.name = "IdempotencyResponseTooLargeError"
  }
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new IdempotencyResponseTooLargeError(maxBytes)
  }
  const body = response.clone().body
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new IdempotencyResponseTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Buffer a response into a storable form. Clones first so the live response body stays intact. */
export async function serializeResponse(
  response: Response,
  options: { readonly maxBytes?: number } = {},
): Promise<StoredResponse> {
  const maxBytes = options.maxBytes
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 0)) {
    throw new RangeError("idempotency: max response bytes must be a non-negative integer")
  }
  const bytes =
    maxBytes === undefined
      ? new Uint8Array(await response.clone().arrayBuffer())
      : await boundedResponseBytes(response, maxBytes)
  return {
    status: response.status,
    headers: replaySafeHeaders(response.headers),
    body: bytes.length > 0 ? bytesToBase64(bytes) : "",
  }
}

/** Rebuild a live response from storage, stamping the replay marker header. */
export function responseFromStored(
  stored: StoredResponse,
  options: { readonly maxBytes?: number } = {},
): Response {
  if (!Number.isInteger(stored.status) || stored.status < 200 || stored.status > 599) {
    throw new TypeError("idempotency: corrupt stored response status")
  }
  const decodedLength = base64DecodedLength(stored.body)
  if (options.maxBytes !== undefined) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new RangeError("idempotency: max response bytes must be a non-negative safe integer")
    }
    if (decodedLength > options.maxBytes) {
      throw new IdempotencyResponseTooLargeError(options.maxBytes)
    }
  }
  const headers = new Headers(replaySafeHeaders(stored.headers) as [string, string][])
  headers.set(IDEMPOTENT_REPLAY_HEADER, "1")
  // Reference the Response body type structurally: `BodyInit` isn't a named type under every lib config,
  // but a fresh `Uint8Array` is a valid body — the cast bridges the `ArrayBufferLike` generic variance.
  const body = (stored.body === "" ? null : base64ToBytes(stored.body)) as ConstructorParameters<
    typeof Response
  >[0]
  return new Response(body, { status: stored.status, headers })
}

interface MemoryEntry {
  readonly fingerprint: string
  readonly reservation: string
  readonly ttlMs: number
  expiresAt: number
  response: StoredResponse | undefined
}

export interface MemoryIdempotencyStoreOptions {
  /** Injectable clock (epoch ms) for deterministic TTL tests. Default `Date.now`. */
  readonly now?: () => number
  /** Hard memory bound. At capacity new keys fail closed; completed/pending entries are never evicted early. */
  readonly maxEntries?: number
}

/**
 * In-process idempotency store. Reservation is atomic by construction — `begin` never awaits, so the
 * single-threaded event loop serializes concurrent callers for one key. Expired entries are treated
 * as absent (lazy eviction on access); a periodic {@link MemoryIdempotencyStore.sweep} bounds memory.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly durability = "memory" as const
  private readonly entries = new Map<string, MemoryEntry>()
  private readonly now: () => number
  private readonly maxEntries: number

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? 10_000
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("idempotency: maxEntries must be a positive integer")
    }
  }

  begin(input: IdempotencyBeginInput): IdempotencyBeginResult {
    const storageKey = this.storageKey(input)
    const existing = this.entries.get(storageKey)
    if (existing !== undefined && existing.expiresAt > this.now()) {
      if (existing.fingerprint !== input.fingerprint) return { state: "mismatch" }
      if (existing.response !== undefined) return { state: "replay", response: existing.response }
      return { state: "in-flight" }
    }
    if (existing !== undefined) this.entries.delete(storageKey)
    if (this.entries.size >= this.maxEntries) {
      this.sweep()
      if (this.entries.size >= this.maxEntries) return { state: "capacity" }
    }
    const reservation = crypto.randomUUID()
    this.entries.set(storageKey, {
      fingerprint: input.fingerprint,
      reservation,
      ttlMs: input.ttlMs,
      expiresAt: this.now() + input.ttlMs,
      response: undefined,
    })
    return { state: "new", reservation }
  }

  complete(input: IdempotencyCompletionInput): boolean {
    const key = this.storageKey(input)
    const entry = this.entries.get(key)
    if (entry === undefined || entry.reservation !== input.reservation) return false
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return false
    }
    entry.response = input.response
    entry.expiresAt = this.now() + entry.ttlMs
    return true
  }

  abandon(input: IdempotencyAbandonInput): boolean {
    const key = this.storageKey(input)
    const entry = this.entries.get(key)
    if (entry !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return false
    }
    // Only drop a still-pending reservation; never evict a completed (replayable) response.
    if (
      entry !== undefined &&
      entry.response === undefined &&
      entry.reservation === input.reservation
    ) {
      this.entries.delete(key)
      return true
    }
    return false
  }

  /** Evict expired entries. Callers may run this on an interval; access-time eviction covers the rest. */
  sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }

  /** Live entry count (post-sweep semantics are the caller's; this is a raw size for tests/metrics). */
  get size(): number {
    return this.entries.size
  }

  private storageKey(input: IdempotencyEntryKey): string {
    return `${input.namespace.length}:${input.namespace}${input.key}`
  }
}

/** Convenience factory mirroring the other core primitives' `create*` style. */
export function createMemoryIdempotencyStore(
  options?: MemoryIdempotencyStoreOptions,
): MemoryIdempotencyStore {
  return new MemoryIdempotencyStore(options)
}

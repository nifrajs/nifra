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
  | { readonly state: "new" }
  | { readonly state: "replay"; readonly response: StoredResponse }
  | { readonly state: "mismatch" }
  | { readonly state: "in-flight" }

/**
 * Storage seam for idempotent responses. `begin` MUST be atomic: for one key, exactly one concurrent
 * caller sees `new`; the rest see `in-flight` (or `replay` once completed). The in-memory store gets
 * this free from the single-threaded event loop; a durable store uses an atomic insert.
 */
export interface IdempotencyStore {
  /** Reserve `key` for `fingerprint`, retaining any stored response for `ttlMs`. */
  begin(
    key: string,
    fingerprint: string,
    ttlMs: number,
  ): IdempotencyBeginResult | Promise<IdempotencyBeginResult>
  /** Persist the final response for a reserved key so later retries replay it. */
  complete(key: string, response: StoredResponse): void | Promise<void>
  /** Release a reservation that produced no cacheable response, so the client may retry. */
  abandon(key: string): void | Promise<void>
}

/** A key must be a non-empty, bounded, control-char-free token. Fail closed on anything else. */
export function validIdempotencyKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > KEY_MAX_LENGTH) return false
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i)
    if (code <= 31 || code === 127) return false
  }
  return true
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
): Promise<string> {
  const head = encoder.encode(`${method.toUpperCase()}\n${path}\n`)
  const material = new Uint8Array(head.length + body.length)
  material.set(head, 0)
  material.set(body, head.length)
  const digest = await crypto.subtle.digest("SHA-256", material)
  const bytes = new Uint8Array(digest)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] as number).toString(16).padStart(2, "0")
  return hex
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

/** Buffer a response into a storable form. Clones first so the live response body stays intact. */
export async function serializeResponse(response: Response): Promise<StoredResponse> {
  const bytes = new Uint8Array(await response.clone().arrayBuffer())
  return {
    status: response.status,
    headers: [...response.headers] as readonly (readonly [string, string])[],
    body: bytes.length > 0 ? bytesToBase64(bytes) : "",
  }
}

/** Rebuild a live response from storage, stamping the replay marker header. */
export function responseFromStored(stored: StoredResponse): Response {
  const headers = new Headers(stored.headers as [string, string][])
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
  readonly expiresAt: number
  response: StoredResponse | undefined
}

export interface MemoryIdempotencyStoreOptions {
  /** Injectable clock (epoch ms) for deterministic TTL tests. Default `Date.now`. */
  readonly now?: () => number
}

/**
 * In-process idempotency store. Reservation is atomic by construction — `begin` never awaits, so the
 * single-threaded event loop serializes concurrent callers for one key. Expired entries are treated
 * as absent (lazy eviction on access); a periodic {@link MemoryIdempotencyStore.sweep} bounds memory.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, MemoryEntry>()
  private readonly now: () => number

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  begin(key: string, fingerprint: string, ttlMs: number): IdempotencyBeginResult {
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.expiresAt > this.now()) {
      if (existing.fingerprint !== fingerprint) return { state: "mismatch" }
      if (existing.response !== undefined) return { state: "replay", response: existing.response }
      return { state: "in-flight" }
    }
    this.entries.set(key, {
      fingerprint,
      expiresAt: this.now() + ttlMs,
      response: undefined,
    })
    return { state: "new" }
  }

  complete(key: string, response: StoredResponse): void {
    const entry = this.entries.get(key)
    if (entry !== undefined) entry.response = response
  }

  abandon(key: string): void {
    const entry = this.entries.get(key)
    // Only drop a still-pending reservation; never evict a completed (replayable) response.
    if (entry !== undefined && entry.response === undefined) this.entries.delete(key)
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
}

/** Convenience factory mirroring the other core primitives' `create*` style. */
export function createMemoryIdempotencyStore(
  options?: MemoryIdempotencyStoreOptions,
): MemoryIdempotencyStore {
  return new MemoryIdempotencyStore(options)
}

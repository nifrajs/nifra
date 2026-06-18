/**
 * Session stores (the **store mode** backend) — a pluggable `SessionStore` plus an in-memory
 * implementation (dev / single-instance, prod-guarded) and a Cloudflare Workers KV implementation
 * (the durable, shared production path). The store is dumb persistence: the session *manager* owns the
 * clock and authoritatively enforces expiry, so the store stays clock-free and trivially testable.
 */

/** A persisted session — its data plus an absolute expiry (ms epoch). */
export interface SessionRecord {
  readonly data: Record<string, unknown>
  /** Absolute expiry (ms epoch). The manager treats `expiresAt <= now` as no session. */
  readonly expiresAt: number
}

/**
 * Pluggable session backend (store mode). Async so a network store (KV/Redis) fits the same shape.
 * **Production needs a shared/durable store** so sessions hold across instances — {@link MemorySessionStore}
 * prod-guards against the per-instance footgun.
 */
export interface SessionStore {
  /** The record for `id`, or `undefined` on a miss. */
  get(id: string): Promise<SessionRecord | undefined>
  /** Store (or overwrite) the record for `id`. */
  set(id: string, record: SessionRecord): Promise<void>
  /** Drop `id` (logout / regeneration). A no-op if absent. */
  delete(id: string): Promise<void>
}

export interface MemorySessionStoreOptions {
  /** Allow the in-memory store in production. Off by default — per-instance sessions don't hold across
   * instances and are lost on restart. */
  readonly allowInProduction?: boolean
  /** Hard cap on stored sessions; the oldest-inserted is evicted past it (default 10_000). */
  readonly max?: number
}

/**
 * In-process session store. Refuses to run in production unless explicitly allowed (mirrors the ISR
 * `MemoryCacheStore` + the rate-limit `MemoryStore` — a per-instance store is unsafe across instances).
 * Bounded: oldest-inserted entries evict past `max`.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly max: number

  constructor(options: MemorySessionStoreOptions = {}) {
    const isProd = typeof process !== "undefined" && process.env?.NODE_ENV === "production"
    if (options.allowInProduction !== true && isProd) {
      throw new Error(
        "[nifra/auth] MemorySessionStore is per-instance and unsafe in production (sessions don't hold " +
          "across instances and are lost on restart). Use a shared store (KVSessionStore, Redis), or " +
          "pass { allowInProduction: true } for a single-instance deploy.",
      )
    }
    this.max = options.max ?? 10_000
  }

  get(id: string): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.sessions.get(id))
  }

  set(id: string, record: SessionRecord): Promise<void> {
    this.sessions.delete(id) // re-insert at the tail so Map order tracks recency for the bounded evict
    this.sessions.set(id, record)
    while (this.sessions.size > this.max) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    return Promise.resolve()
  }

  delete(id: string): Promise<void> {
    this.sessions.delete(id)
    return Promise.resolve()
  }
}

/**
 * Minimal structural shape of a Cloudflare Workers **KV namespace** binding — just the three methods
 * {@link KVSessionStore} uses. Structural (no `@cloudflare/workers-types` dependency) so any KV-like
 * binding satisfies it and tests can pass an in-memory double.
 */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>
  /** `expiration` is an absolute unix-seconds timestamp (Cloudflare KV auto-evicts past it). */
  put(key: string, value: string, options?: { readonly expiration?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** Structural validation of a KV-read value before it's trusted as a {@link SessionRecord}. The store
 * is a trust boundary (corruption, version skew, tampering), so a malformed entry reads as a miss
 * (no session) rather than a thrown error or a half-valid record. */
const isSessionRecord = (value: unknown): value is SessionRecord => {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.expiresAt === "number" &&
    Number.isFinite(v.expiresAt) &&
    typeof v.data === "object" &&
    v.data !== null
  )
}

/**
 * A {@link SessionStore} backed by a **Cloudflare Workers KV** namespace (or any {@link KVNamespaceLike})
 * — the durable, shared production store: sessions hold across worker instances and survive restarts.
 * Records serialize to JSON; the entry's KV `expiration` is set from the record's `expiresAt` so KV
 * auto-evicts the session (a GC backstop — the manager still authoritatively checks expiry on read).
 * Every read is validated, so a corrupt/skewed entry reads as no session.
 */
export class KVSessionStore implements SessionStore {
  private readonly kv: KVNamespaceLike

  constructor(kv: KVNamespaceLike) {
    this.kv = kv
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const raw = await this.kv.get(id)
    if (raw === null) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined // corrupt entry → no session (the next set overwrites it)
    }
    return isSessionRecord(parsed) ? parsed : undefined
  }

  async set(id: string, record: SessionRecord): Promise<void> {
    // Absolute KV expiry (unix seconds) as a GC backstop. Cloudflare requires it be ≥ 60s out; session
    // `maxAge` is realistically minutes+, so a real deploy satisfies that (the manager enforces the
    // exact expiry regardless).
    await this.kv.put(id, JSON.stringify(record), {
      expiration: Math.floor(record.expiresAt / 1000),
    })
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(id)
  }
}

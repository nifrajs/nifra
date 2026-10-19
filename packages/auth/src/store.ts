/**
 * Session stores (the **store mode** backend) - a pluggable `SessionStore` plus an in-memory
 * implementation (dev / single-instance, prod-guarded) and a Cloudflare Workers KV implementation
 * (the durable, shared production path). The store is dumb persistence: the session *manager* owns the
 * clock and authoritatively enforces expiry, so the store stays clock-free and trivially testable.
 */

/** A persisted session - its data plus an absolute expiry (ms epoch). */
export interface SessionRecord {
  readonly data: Record<string, unknown>
  /** Absolute expiry (ms epoch). The manager treats `expiresAt <= now` as no session. */
  readonly expiresAt: number
}

/**
 * Pluggable session backend (store mode). Async so a network store (KV/Redis) fits the same shape.
 * **Production needs a shared/durable store** so sessions hold across instances - {@link MemorySessionStore}
 * prod-guards against the per-instance footgun. Logout and rotation also write a revocation marker, an
 * empty record under `<id>.revoked`, and rotation one under `<id>.rotated`, so a store must accept those
 * keys like any other and keep each until its `expiresAt`. A dropped marker lets a request that loaded
 * the session before the logout write it back, unless the store implements `replace`; it also lets a
 * rotated generation outlive a logout made with an earlier generation's cookie.
 */
export interface SessionStore {
  /** The record for `id`, or `undefined` on a miss. */
  get(id: string): Promise<SessionRecord | undefined>
  /** Store (or overwrite) the record for `id`. */
  set(id: string, record: SessionRecord): Promise<void>
  /** Drop `id` (logout / regeneration). A no-op if absent. */
  delete(id: string): Promise<void>
  /**
   * Overwrite `id` only while it still holds a record, resolving whether it wrote. The check and the
   * write must be one atomic step that also sets the new expiry, such as Redis
   * `SET key value XX PXAT <record.expiresAt>` (a bare `XX` drops the key's TTL) or a SQL
   * `UPDATE ... WHERE id = ?` that reports the rows it changed. Optional: when present, a loaded session renews through it instead
   * of `set`, so a logout that lands between the renewal's checks and its write wins even after the
   * logout's revocation marker is gone.
   */
  replace?(id: string, record: SessionRecord): Promise<boolean>
  /**
   * Move the record at `previousId` to `nextId` only while it exists, is unrevoked and was not rotated
   * already, resolving whether it moved. One atomic step writes `marker` under `<previousId>.rotated`,
   * deletes `previousId` and stores `record` at `nextId`; it refuses when `<previousId>.revoked` or the
   * revocation marker of the original ID (the part before `~`) exists. Optional: without it, rotation
   * makes those writes one at a time and checks the revocation afterwards.
   */
  rotate?(
    previousId: string,
    nextId: string,
    record: SessionRecord,
    marker: SessionRecord,
  ): Promise<boolean>
}

/** The suffix of a revocation marker's key: `<id>.revoked`. */
export const REVOKED_SUFFIX = ".revoked"
export const ROTATED_SUFFIX = ".rotated"

// A rotated cookie carries its original ID, so logout of any generation revokes them all. That ID
// may be a legacy cookie's value of any length; a rotation only ever appends one random part.
export const sessionFamily = (id: string): string =>
  /^([^~]+)~[A-Za-z0-9_-]{43}$/.exec(id)?.[1] ?? id

export const isSessionMarker = (id: string): boolean =>
  id.endsWith(REVOKED_SUFFIX) || id.endsWith(ROTATED_SUFFIX)

/** A generic store retains logout markers separately: rotating must never overwrite a racing logout. */
export async function rotateExisting(
  store: SessionStore,
  previousId: string,
  nextId: string,
  record: SessionRecord,
  marker: SessionRecord,
): Promise<boolean> {
  if (store.rotate !== undefined) return store.rotate(previousId, nextId, record, marker)
  await store.set(`${previousId}${ROTATED_SUFFIX}`, marker)
  await store.delete(previousId)
  await store.set(nextId, record)
  if ((await store.get(`${sessionFamily(previousId)}${REVOKED_SUFFIX}`)) !== undefined) {
    await store.delete(nextId)
    return false
  }
  return true
}

export interface MemorySessionStoreOptions {
  /** Allow the in-memory store in production. Off by default - per-instance sessions don't hold across
   * instances and are lost on restart. */
  readonly allowInProduction?: boolean
  /** Hard cap on stored sessions; the oldest-inserted is evicted past it (default 10_000). Revocation
   * markers are capped by it separately, so new sessions never evict one. */
  readonly max?: number
}

/**
 * In-process session store. Refuses to run in production unless explicitly allowed (mirrors the ISR
 * `MemoryCacheStore` + the rate-limit `MemoryStore` - a per-instance store is unsafe across instances).
 * Bounded: oldest-inserted entries evict past `max`, sessions and revocation markers each on their own.
 * Because a marker can be evicted, it implements `replace`, so a request that loaded the session before
 * a logout cannot restore it once the marker is gone.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly families = new Map<string, Set<string>>()
  // Apart from the sessions: anonymous sessions written after a logout must not push its marker out.
  // Markers share one lifetime, so the oldest-inserted is the first to expire.
  private readonly markers = new Map<string, SessionRecord>()
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
    if (!Number.isSafeInteger(this.max) || this.max <= 0) {
      throw new RangeError("[nifra/auth] MemorySessionStore max must be a positive safe integer")
    }
  }

  private mapFor(id: string): Map<string, SessionRecord> {
    return isSessionMarker(id) ? this.markers : this.sessions
  }

  get(id: string): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.mapFor(id).get(id))
  }

  set(id: string, record: SessionRecord): Promise<void> {
    this.write(this.mapFor(id), id, record)
    if (id.endsWith(REVOKED_SUFFIX)) {
      const family = id.slice(0, -REVOKED_SUFFIX.length)
      // A bounded marker can later be evicted. Remove every generation now so conditional renewals
      // and rotations cannot restore it after that eviction.
      const members = this.families.get(family)
      if (members !== undefined) for (const key of members) this.removeSession(key)
    }
    return Promise.resolve()
  }

  delete(id: string): Promise<void> {
    if (isSessionMarker(id)) this.markers.delete(id)
    else this.removeSession(id)
    return Promise.resolve()
  }

  replace(id: string, record: SessionRecord): Promise<boolean> {
    const entries = this.mapFor(id)
    if (!entries.has(id)) return Promise.resolve(false)
    this.write(entries, id, record)
    return Promise.resolve(true)
  }

  rotate(
    previousId: string,
    nextId: string,
    record: SessionRecord,
    marker: SessionRecord,
  ): Promise<boolean> {
    if (
      !this.sessions.has(previousId) ||
      this.markers.has(`${previousId}${REVOKED_SUFFIX}`) ||
      this.markers.has(`${sessionFamily(previousId)}${REVOKED_SUFFIX}`) ||
      this.markers.has(`${previousId}${ROTATED_SUFFIX}`)
    )
      return Promise.resolve(false)
    this.write(this.markers, `${previousId}${ROTATED_SUFFIX}`, marker)
    this.removeSession(previousId)
    this.write(this.sessions, nextId, record)
    return Promise.resolve(true)
  }

  private write(entries: Map<string, SessionRecord>, id: string, record: SessionRecord): void {
    entries.delete(id) // re-insert at the tail so Map order tracks recency for the bounded evict
    entries.set(id, record)
    if (entries === this.sessions) {
      const family = sessionFamily(id)
      let members = this.families.get(family)
      if (members === undefined) {
        members = new Set()
        this.families.set(family, members)
      }
      members.add(id)
    }
    while (entries.size > this.max) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      if (entries === this.sessions) this.removeSession(oldest)
      else entries.delete(oldest)
    }
  }

  private removeSession(id: string): void {
    this.sessions.delete(id)
    const family = sessionFamily(id)
    const members = this.families.get(family)
    members?.delete(id)
    if (members?.size === 0) this.families.delete(family)
  }
}

/**
 * Minimal structural shape of a Cloudflare Workers **KV namespace** binding - just the three methods
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
 * - the durable, shared production store: sessions hold across worker instances and survive restarts.
 * Records serialize to JSON; the entry's KV `expiration` is set from the record's `expiresAt` so KV
 * auto-evicts the session (a GC backstop - the manager still authoritatively checks expiry on read).
 * Every read is validated, so a corrupt/skewed entry reads as no session. Workers KV has no conditional
 * write, so this store leaves out `replace` and keeps each revocation marker until its `expiresAt`.
 */
export class KVSessionStore implements SessionStore {
  private readonly kv: KVNamespaceLike
  private readonly now: () => number

  constructor(kv: KVNamespaceLike, options: { readonly now?: () => number } = {}) {
    this.kv = kv
    this.now = options.now ?? (() => Date.now())
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
    // Cloudflare requires absolute expiration to be at least 60 seconds in the future. Clamp only the
    // KV garbage-collection backstop; the session manager still rejects at the exact `expiresAt`, so a
    // one-second session cannot remain valid for the platform's extra retention window.
    const platformFloor = Math.ceil(this.now() / 1000) + 60
    const expiration = Math.max(Math.floor(record.expiresAt / 1000), platformFloor)
    await this.kv.put(id, JSON.stringify(record), {
      expiration,
    })
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(id)
  }
}

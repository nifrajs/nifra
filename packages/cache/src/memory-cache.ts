/**
 * In-process {@link CacheStore} - a Map with lazy expiry, a tag index for group invalidation, and an
 * optional LRU cap. Correct for a single instance; for a cache shared across instances/workers, implement
 * `CacheStore` over CF KV / Redis. Not persisted (a restart empties it).
 */
import type { CacheStore, StoredEntry } from "./types.ts"

interface Row {
  value: unknown
  expiresAt: number
  staleAt: number
  tags: readonly string[]
}

// How many distinct keys (and, separately, tags) the fence remembers changing. A load that outlives
// this many distinct changes is refused its write, which costs one cache miss, never a stale value.
const MAX_TRACKED_CHANGES = 65_536

export interface MemoryCacheOptions {
  /** Evict the least-recently-used entry once the count exceeds this. Default 10,000; `0` explicitly
   * opts into an unbounded cache. */
  readonly maxEntries?: number
  /** Injectable clock (tests). Default `() => Date.now()`. */
  readonly now?: () => number
}

export class MemoryCache implements CacheStore {
  // Map iteration is insertion-ordered, so the first key is the LRU victim; `get`/`set` re-insert to touch.
  private readonly rows = new Map<string, Row>()
  private readonly tagIndex = new Map<string, Set<string>>()
  private expirySweep = this.rows.entries()
  private readonly maxEntries: number
  private readonly now: () => number
  // The epoch of each key's and tag's latest change, oldest first. Only the change that matters to a
  // load is compared, so unrelated writes never age its fence out. Bounded: a fence older than a
  // forgotten change is refused.
  private readonly keyChanges = new Map<string, number>()
  private readonly tagChanges = new Map<string, number>()
  private clearedAt = 0
  private forgottenAt = 0
  private epoch = 0

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 0) {
      throw new RangeError("MemoryCache: maxEntries must be a non-negative safe integer")
    }
    this.now = options.now ?? (() => Date.now())
  }

  get(key: string): StoredEntry | undefined {
    const row = this.rows.get(key)
    if (row === undefined) return undefined
    if (this.now() >= row.expiresAt) {
      this.evict(key)
      return undefined
    }
    // LRU touch.
    this.rows.delete(key)
    this.rows.set(key, row)
    return { value: row.value, expiresAt: row.expiresAt, staleAt: row.staleAt }
  }

  set(key: string, entry: StoredEntry, tags: readonly string[]): void {
    this.record(this.keyChanges, key)
    // Incremental expiry keeps cold, high-cardinality keys from occupying the entire bound until
    // their exact key is read. A fixed batch avoids an O(n) latency spike on a write.
    this.sweepExpired(8)
    this.evict(key) // clear any prior tag links before overwriting
    this.rows.set(key, {
      value: entry.value,
      expiresAt: entry.expiresAt,
      staleAt: entry.staleAt,
      tags,
    })
    for (const tag of tags) {
      let set = this.tagIndex.get(tag)
      if (set === undefined) {
        set = new Set()
        this.tagIndex.set(tag, set)
      }
      set.add(key)
    }
    if (this.maxEntries > 0 && this.rows.size > this.maxEntries) {
      const oldest = this.rows.keys().next().value
      if (oldest !== undefined) this.evict(oldest)
    }
  }

  delete(key: string): void {
    this.record(this.keyChanges, key)
    this.evict(key)
  }

  invalidateTag(tag: string): void {
    this.record(this.tagChanges, tag)
    const keys = this.tagIndex.get(tag)
    if (keys === undefined) return
    for (const key of [...keys]) this.evict(key)
  }

  clear(): void {
    // Every older fence is refused from here on, so the earlier changes need no remembering.
    this.clearedAt = ++this.epoch
    this.keyChanges.clear()
    this.tagChanges.clear()
    this.rows.clear()
    this.tagIndex.clear()
    this.expirySweep = this.rows.entries()
  }

  /** The current epoch: {@link MemoryCache.setIfFence} compares what changed after it. */
  fence(): number {
    return this.epoch
  }

  setIfFence(key: string, entry: StoredEntry, tags: readonly string[], token: unknown): boolean {
    if (typeof token !== "number" || !Number.isSafeInteger(token) || token > this.epoch)
      return false
    if (token < this.clearedAt || token < this.forgottenAt) return false
    if ((this.keyChanges.get(key) ?? 0) > token) return false
    for (const tag of tags) if ((this.tagChanges.get(tag) ?? 0) > token) return false
    this.set(key, entry, tags)
    return true
  }

  /** Live entry count (for observability/tests). */
  size(): number {
    return this.rows.size
  }

  private record(changes: Map<string, number>, name: string): void {
    changes.delete(name)
    changes.set(name, ++this.epoch)
    if (changes.size <= MAX_TRACKED_CHANGES) return
    const first = changes.entries().next()
    if (first.done) return
    const [oldest, at] = first.value
    changes.delete(oldest)
    this.forgottenAt = Math.max(this.forgottenAt, at)
  }

  /** Remove a key and unlink it from every tag set it belonged to. */
  private evict(key: string): void {
    const row = this.rows.get(key)
    if (row === undefined) return
    this.rows.delete(key)
    for (const tag of row.tags) {
      const set = this.tagIndex.get(tag)
      if (set !== undefined) {
        set.delete(key)
        if (set.size === 0) this.tagIndex.delete(tag)
      }
    }
  }

  private sweepExpired(limit: number): void {
    let restarted = false
    for (let scanned = 0; scanned < limit; ) {
      const next = this.expirySweep.next()
      if (next.done) {
        if (restarted) return // the map is empty, or the fresh iterator also reached its end
        this.expirySweep = this.rows.entries()
        restarted = true
        continue
      }
      restarted = false
      scanned++
      const [key, row] = next.value
      // The key may have been overwritten since the iterator produced its row; only evict that exact
      // entry so a fresh value is never removed by a stale sweep observation.
      if (this.rows.get(key) === row && this.now() >= row.expiresAt) this.evict(key)
    }
  }
}

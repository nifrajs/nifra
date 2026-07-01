/**
 * In-process {@link CacheStore} — a Map with lazy expiry, a tag index for group invalidation, and an
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

export interface MemoryCacheOptions {
  /** Evict the least-recently-used entry once the count exceeds this. `0` (default) = unbounded. */
  readonly maxEntries?: number
  /** Injectable clock (tests). Default `() => Date.now()`. */
  readonly now?: () => number
}

export class MemoryCache implements CacheStore {
  // Map iteration is insertion-ordered, so the first key is the LRU victim; `get`/`set` re-insert to touch.
  private readonly rows = new Map<string, Row>()
  private readonly tagIndex = new Map<string, Set<string>>()
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 0
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
    this.evict(key)
  }

  invalidateTag(tag: string): void {
    const keys = this.tagIndex.get(tag)
    if (keys === undefined) return
    for (const key of [...keys]) this.evict(key)
  }

  clear(): void {
    this.rows.clear()
    this.tagIndex.clear()
  }

  /** Live entry count (for observability/tests). */
  size(): number {
    return this.rows.size
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
}

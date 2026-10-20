/**
 * Which keys changed since a watermark: a ring of `(seq, key hash)` pairs, 16 bytes each, with the
 * newest seq per hash beside it. History is complete for every seq above {@link History.floor}; a
 * watermark at or below it, or one this process has not reached, is unknown and reads as changed.
 */

export const HISTORY_ENTRIES = 100_000
export const HISTORY_MS = 120_000

export class History {
  private readonly seqs: Float64Array
  private readonly hashes: Float64Array
  private readonly latest = new Map<number, number>()
  private start = 0
  private size = 0
  /** Every event with a seq above this is recorded. */
  floor: number
  /** The last recorded event's seq. */
  last: number

  constructor(
    head: number,
    private readonly capacity = HISTORY_ENTRIES,
    private readonly maxAgeMs = HISTORY_MS,
  ) {
    this.seqs = new Float64Array(capacity)
    this.hashes = new Float64Array(capacity)
    this.floor = head
    this.last = head
  }

  record(seq: number, hashes: readonly number[], nowMs: number): void {
    for (const hash of hashes) {
      if (this.size === this.capacity) this.evict()
      const at = (this.start + this.size) % this.capacity
      this.seqs[at] = seq
      this.hashes[at] = hash
      this.size++
      this.latest.set(hash, seq)
    }
    this.last = seq
    this.prune(nowMs)
  }

  /** Mark history up to `seq` as seen with nothing to record (a revocation). */
  advance(seq: number, nowMs: number): void {
    this.last = seq
    this.prune(nowMs)
  }

  /** `true` when the key may have changed after `watermark`. */
  changedSince(hash: number, watermark: number): boolean {
    if (!this.known(watermark)) return true
    const seq = this.latest.get(hash)
    return seq !== undefined && seq > watermark
  }

  known(watermark: number): boolean {
    return watermark >= this.floor && watermark <= this.last
  }

  /** Forget everything: what happened up to `head` is unknown. */
  reset(head: number): void {
    this.latest.clear()
    this.start = 0
    this.size = 0
    this.floor = head
    this.last = head
  }

  /** Seqs count microseconds, so an entry's age is read off its seq. */
  private prune(nowMs: number): void {
    const oldest = (nowMs - this.maxAgeMs) * 1000
    while (this.size > 0 && (this.seqs[this.start] ?? 0) < oldest) this.evict()
  }

  private evict(): void {
    const seq = this.seqs[this.start] ?? 0
    const hash = this.hashes[this.start] ?? 0
    if (this.latest.get(hash) === seq) this.latest.delete(hash)
    if (seq > this.floor) this.floor = seq
    this.start = (this.start + 1) % this.capacity
    this.size--
  }
}

/**
 * A 53-bit keyed hash (cyrb53 with per-process seeds). A collision only costs a spurious reload, and
 * the seeds keep anyone from choosing keys that collide with another.
 */
export function keyHasher(): (key: string) => number {
  const seeds = crypto.getRandomValues(new Uint32Array(2))
  const seed1 = seeds[0] ?? 0
  const seed2 = seeds[1] ?? 0
  return (key) => {
    let h1 = 0xdeadbeef ^ seed1
    let h2 = 0x41c6ce57 ^ seed2
    for (let i = 0; i < key.length; i++) {
      const ch = key.charCodeAt(i)
      h1 = Math.imul(h1 ^ ch, 2654435761)
      h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 >>> 0)
  }
}

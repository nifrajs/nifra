/** What {@link markRepeatedPrefix} recorded for a chunk. */
export interface RepeatedPrefix {
  /** Bytes the producer sends again in later responses and never changes. */
  readonly source: Uint8Array
  /** How many of `source`'s leading bytes the chunk starts with. */
  readonly length: number
}

const prefixes = new WeakMap<Uint8Array, RepeatedPrefix>()

/**
 * Record that `chunk` starts with the first `length` bytes of `source`: bytes its producer sends again
 * in later responses and never changes, such as a cached page shell. A response observer that
 * transforms streamed bodies may keep its work on those bytes, keyed by `source`, and reuse it. It must
 * check that the chunk still holds them, since a later reader may have written into the chunk.
 */
export function markRepeatedPrefix(chunk: Uint8Array, source: Uint8Array, length: number): void {
  if (!Number.isSafeInteger(length) || length <= 0) return
  if (length > chunk.byteLength || length > source.byteLength) return
  prefixes.set(chunk, { source, length })
}

/** The repeated prefix {@link markRepeatedPrefix} recorded for `chunk`, if any. */
export const repeatedPrefixOf = (chunk: Uint8Array): RepeatedPrefix | undefined =>
  prefixes.get(chunk)

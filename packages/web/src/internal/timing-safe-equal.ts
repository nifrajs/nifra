/**
 * Constant-time string equality, shared by every secret check in `@nifrajs/web`. Internal: no
 * `exports` entry points here, so it never becomes public API.
 *
 * One owner per package rather than a copy per call site — this is the primitive whose whole value
 * lies in a detail (no early exit) that a well-meaning "simplification" silently removes, and a bug
 * in it is invisible in review and in tests, since a timing-unsafe compare returns the same answers.
 */

/**
 * Compare two strings without leaking, via timing, where they first differ. A length mismatch returns
 * `false` up front: the length isn't the secret, and different-length buffers can't be compared in
 * constant time anyway. Encodes to bytes first so multi-byte characters compare by content, not by
 * UTF-16 code unit.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ba = enc.encode(a)
  const bb = enc.encode(b)
  if (ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= (ba[i] as number) ^ (bb[i] as number)
  return diff === 0
}

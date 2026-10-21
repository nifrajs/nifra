/**
 * Stored revocations, checked on every use of a grant. An entry is kept for one grant lifetime plus
 * clock skew: by then every grant issued before it has expired.
 */
import type { LiveRevocation } from "./bus.ts"
import type { GrantClaims } from "./keyring.ts"

/** Past this many stored entries, one global revocation replaces them all. */
export const MAX_REVOCATIONS = 100_000
/** How far clocks may disagree; a revocation is kept this much past the grant lifetime. */
export const REVOCATION_SKEW_MS = 120_000

interface Stamp {
  readonly seq: number
  readonly at: number
}

/** What a load checks a grant against. */
export interface RevocationCheck {
  grantRevoked(claims: GrantClaims): boolean
  keyRevoked(key: string, claims: GrantClaims): boolean
}

/** The stored revocations that bear on a few subjects and keys: what the Workers hub tells a load. */
export interface RevocationSnapshot {
  readonly floor: number
  readonly subjects: Readonly<Record<string, number>>
  readonly keys: Readonly<Record<string, number>>
  /** By `key + "\0" + subject`. */
  readonly subjectKeys: Readonly<Record<string, number>>
}

export class Revocations implements RevocationCheck {
  /** A grant issued below this seq is refused whole: `revokeAll`, or history this process lacks. */
  floor: number
  private readonly subjects = new Map<string, Stamp>()
  private readonly keys = new Map<string, Stamp>()
  /** `key + "\0" + subject`; the key charset has no NUL. */
  private readonly subjectKeys = new Map<string, Stamp>()

  constructor(
    head: number,
    private readonly ttlMs: number,
    private readonly limit = MAX_REVOCATIONS,
  ) {
    this.floor = head
  }

  apply(event: LiveRevocation & { readonly seq: number }, nowMs: number): void {
    this.prune(nowMs)
    const stamp = { seq: event.seq, at: nowMs }
    if (event.key === null) {
      if (event.sub === null) this.raise(event.seq)
      else renew(this.subjects, event.sub, stamp)
    } else if (event.sub === null) {
      renew(this.keys, event.key, stamp)
    } else {
      renew(this.subjectKeys, `${event.key}\0${event.sub}`, stamp)
    }
    if (this.subjects.size + this.keys.size + this.subjectKeys.size > this.limit) {
      console.error(
        `[nifra/web] live: more than ${this.limit} stored revocations; every grant issued before now is refused instead`,
      )
      this.raise(event.seq)
    }
  }

  /** Refuse every grant issued below `seq`; the stored entries are all older, so they go. */
  raise(seq: number): void {
    if (seq > this.floor) this.floor = seq
    this.subjects.clear()
    this.keys.clear()
    this.subjectKeys.clear()
  }

  grantRevoked(claims: GrantClaims): boolean {
    return (
      claims.s < this.floor ||
      (claims.sub !== null && above(this.subjects.get(claims.sub), claims.s))
    )
  }

  keyRevoked(key: string, claims: GrantClaims): boolean {
    return (
      above(this.keys.get(key), claims.s) ||
      (claims.sub !== null && above(this.subjectKeys.get(`${key}\0${claims.sub}`), claims.s))
    )
  }

  /** The entries for these subjects and keys, and every pairing of them. */
  snapshot(subjects: readonly string[], keys: readonly string[]): RevocationSnapshot {
    const pairs: string[] = []
    for (const key of keys) for (const sub of subjects) pairs.push(`${key}\0${sub}`)
    return {
      floor: this.floor,
      subjects: pick(this.subjects, subjects),
      keys: pick(this.keys, keys),
      subjectKeys: pick(this.subjectKeys, pairs),
    }
  }

  private prune(nowMs: number): void {
    const horizon = nowMs - this.ttlMs - REVOCATION_SKEW_MS
    for (const map of [this.subjects, this.keys, this.subjectKeys]) {
      // Insertion order is age order (see `renew`), so the stale entries are a prefix.
      for (const [name, stamp] of map) {
        if (stamp.at >= horizon) break
        map.delete(name)
      }
    }
  }
}

const above = (stamp: Stamp | undefined, s: number): boolean => stamp !== undefined && stamp.seq > s

function pick(map: Map<string, Stamp>, names: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of names) {
    const stamp = map.get(name)
    if (stamp !== undefined) out[name] = stamp.seq
  }
  return out
}

/** Re-insert so the map stays in age order. */
function renew(map: Map<string, Stamp>, name: string, stamp: Stamp): void {
  map.delete(name)
  map.set(name, stamp)
}

/** {@link RevocationCheck} over a {@link RevocationSnapshot}: the same answers for what it covers. */
export class RevocationView implements RevocationCheck {
  constructor(private readonly snapshot: RevocationSnapshot) {}

  grantRevoked(claims: GrantClaims): boolean {
    return (
      claims.s < this.snapshot.floor ||
      (claims.sub !== null && stampAbove(this.snapshot.subjects, claims.sub, claims.s))
    )
  }

  keyRevoked(key: string, claims: GrantClaims): boolean {
    return (
      stampAbove(this.snapshot.keys, key, claims.s) ||
      (claims.sub !== null &&
        stampAbove(this.snapshot.subjectKeys, `${key}\0${claims.sub}`, claims.s))
    )
  }
}

function stampAbove(stamps: Readonly<Record<string, number>>, name: string, s: number): boolean {
  const seq = Object.hasOwn(stamps, name) ? stamps[name] : undefined
  return seq !== undefined && seq > s
}

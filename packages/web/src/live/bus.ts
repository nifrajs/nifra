/**
 * The live bus: one ordered log of changes and revocations that every process serving the app reads.
 * Its sequence numbers never leave the server.
 *
 * A bus assigns each appended event a seq from a hybrid logical clock in microseconds: never below
 * `Date.now() * 1000` at the authority, always above the previous seq. A restarted authority therefore
 * keeps counting upward, and an entry's age can be read off its seq.
 */

/** Something a loader declared with `ctx.live` changed. */
export interface LiveChange {
  readonly type: "change"
  readonly keys: readonly string[]
}

/**
 * Grants issued before this event stop working: every grant (`sub` and `key` null), one subject's
 * (`key` null), or, with `key`, any grant holding that key (for everyone, or for `sub`).
 */
export interface LiveRevocation {
  readonly type: "revoke"
  readonly sub: string | null
  readonly key: string | null
}

export type LiveBusInput = LiveChange | LiveRevocation

export type LiveBusEvent = LiveBusInput & { readonly seq: number }

export interface LiveBusListener {
  /** The next event, in seq order. */
  event(event: LiveBusEvent): void
  /**
   * Events up to `head` may be lost (a trimmed stream, a reconnect): what happened before `head` is
   * unknown, and delivery resumes with the events after it.
   */
  gap(head: number): void
  /** The bus is unreachable; the next {@link gap} reports where delivery resumes. */
  down(): void
}

export interface LiveBusSubscription {
  /** The seq of the last event before delivery starts. */
  readonly head: number
  close(): void
}

export interface LiveBus {
  /** Append one event; resolves with its seq. */
  append(input: LiveBusInput): Promise<number>
  /** Deliver every event after the returned head to `listener`, in seq order. */
  subscribe(listener: LiveBusListener): Promise<LiveBusSubscription>
}

/** The seq a clock reading allows, never at or below `last`. */
export const nextSeq = (last: number, nowMs: number): number => Math.max(last + 1, nowMs * 1000)

/**
 * The single-process bus: an in-memory clock, events delivered to every subscriber before `append`
 * resolves. Processes do not share it; run several behind a shared bus instead.
 */
export function memoryBus(): LiveBus {
  let last = nextSeq(0, Date.now())
  const listeners = new Set<LiveBusListener>()
  return {
    async append(input) {
      last = nextSeq(last, Date.now())
      const event: LiveBusEvent = { ...input, seq: last }
      for (const listener of listeners) listener.event(event)
      return last
    },
    async subscribe(listener) {
      listeners.add(listener)
      return { head: last, close: () => listeners.delete(listener) }
    },
  }
}

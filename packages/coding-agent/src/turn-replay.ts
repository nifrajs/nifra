export interface TurnReplayLimits {
  readonly maxEvents: number
  readonly maxBytes: number
}

interface HeldFrame {
  readonly seq: number
  readonly bytes: Uint8Array
}

interface TurnListener {
  frame(bytes: Uint8Array): void
  end(terminal: Uint8Array | undefined): void
}

/**
 * One `turn.send`'s SSE frames, held so a client that dropped can read what it missed and follow
 * the rest. Cursors are the host's event seqs; one older than what is held needs a resync.
 */
export class ReplayableTurn {
  private readonly held: HeldFrame[] = []
  private heldBytes = 0
  private droppedThrough: number
  private lastSeq: number
  private ended = false
  private terminal: Uint8Array | undefined
  private readonly listeners = new Set<TurnListener>()

  /**
   * @param startedAfter the last seq before this turn: a cursor there reads the whole turn.
   * @param onListeners told how many clients follow the turn whenever that changes while it runs.
   */
  constructor(
    private readonly startedAfter: number,
    private readonly limits: TurnReplayLimits,
    private readonly onListeners: (count: number) => void,
  ) {
    this.droppedThrough = startedAfter
    this.lastSeq = startedAfter
  }

  get done(): boolean {
    return this.ended
  }

  get latestSeq(): number {
    return this.lastSeq
  }

  get following(): number {
    return this.listeners.size
  }

  push(seq: number, frame: Uint8Array): void {
    if (this.ended) return
    this.held.push({ seq, bytes: frame })
    this.heldBytes += frame.byteLength
    this.lastSeq = seq
    // The newest frame always stays, even past maxBytes, so a client can follow a large event.
    while (
      this.held.length > this.limits.maxEvents ||
      (this.heldBytes > this.limits.maxBytes && this.held.length > 1)
    ) {
      const dropped = this.held.shift()
      if (dropped === undefined) break
      this.heldBytes -= dropped.bytes.byteLength
      this.droppedThrough = dropped.seq
    }
    for (const listener of [...this.listeners]) {
      try {
        listener.frame(frame)
      } catch {
        this.detach(listener)
      }
    }
  }

  end(terminal?: Uint8Array): void {
    if (this.ended) return
    this.ended = true
    this.terminal = terminal
    const listeners = [...this.listeners]
    this.listeners.clear()
    for (const listener of listeners) {
      try {
        listener.end(terminal)
      } catch {
        // That client already went away.
      }
    }
  }

  /**
   * The frames after `afterSeq` (the whole turn when omitted), then the live ones until the turn
   * ends. `undefined` when the cursor is older than what is held, or newer than any frame sent.
   */
  attach(afterSeq?: number): ReadableStream<Uint8Array> | undefined {
    const cursor = afterSeq ?? this.startedAfter
    if (cursor < this.droppedThrough || cursor > this.lastSeq) return undefined
    return this.open(cursor)
  }

  /** The whole turn from its first frame; always available to the client that started it. */
  follow(): ReadableStream<Uint8Array> {
    return this.open(this.startedAfter)
  }

  private open(cursor: number): ReadableStream<Uint8Array> {
    let listener: TurnListener | undefined
    // The queue counts bytes, so it can tell a follower that stopped reading: one more than the held
    // budget behind the held frames is dropped, and can attach again from the last seq it read.
    const behind = -this.limits.maxBytes
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          for (const frame of this.held) if (frame.seq > cursor) controller.enqueue(frame.bytes)
          if (this.ended) {
            if (this.terminal !== undefined) controller.enqueue(this.terminal)
            controller.close()
            return
          }
          listener = {
            frame: (bytes) => {
              if ((controller.desiredSize ?? 0) < behind) {
                const reason = new Error("turn follower fell behind")
                controller.error(reason)
                throw reason
              }
              controller.enqueue(bytes)
            },
            end: (terminal) => {
              if (terminal !== undefined) controller.enqueue(terminal)
              controller.close()
            },
          }
          this.listeners.add(listener)
          this.onListeners(this.listeners.size)
        },
        cancel: () => {
          if (listener !== undefined) this.detach(listener)
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: this.limits.maxBytes }),
    )
  }

  private detach(listener: TurnListener): void {
    if (!this.listeners.delete(listener) || this.ended) return
    this.onListeners(this.listeners.size)
  }
}

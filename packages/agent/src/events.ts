import type { AgentStepEvidence, AgentTelemetryPort } from "./index.ts"

/** Options for the lifecycle evidence stream. */
export interface AgentEvidenceStreamOptions {
  /** Maximum number of produced evidence items waiting for a consumer. Default 1024. */
  readonly maxQueueSize?: number
}

/**
 * The existing step evidence as an async iterable. No second event vocabulary is introduced.
 *
 * Pass the stream as `ports.telemetry`, consume it with `for await`, and call `complete()` when the
 * runner finishes. The stream keeps queued evidence until it has been consumed, then terminates.
 */
export interface AgentEvidenceStream
  extends AgentTelemetryPort,
    AsyncIterableIterator<AgentStepEvidence> {
  complete(): void
  /**
   * How many evidence items the queue discarded because the consumer fell behind. Non-zero means the
   * `seq` sequence has gaps; the turn result still carries the complete, authoritative evidence array.
   */
  readonly dropped: number
}

/** Create an async iterable that yields the exact evidence values received by `step`. */
export function createAgentEvidenceStream(
  options: AgentEvidenceStreamOptions = {},
): AgentEvidenceStream {
  const maxQueueSize = options.maxQueueSize ?? 1024
  if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1)
    throw new RangeError("agent evidence stream: maxQueueSize must be a positive safe integer")

  const queue: AgentStepEvidence[] = []
  const waiters: Array<(result: IteratorResult<AgentStepEvidence>) => void> = []
  let completed = false
  let dropped = 0

  const finishWaiters = (): void => {
    if (!completed || queue.length > 0) return
    while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined })
  }

  const stream: AgentEvidenceStream = {
    get dropped() {
      return dropped
    },
    step(evidence) {
      if (completed) return
      const waiter = waiters.shift()
      if (waiter !== undefined) {
        waiter({ done: false, value: evidence })
        return
      }
      // A consumer that stopped reading (a closed SSE connection is the common one) must never fail
      // the turn it is observing. The queue is a live view; the authoritative evidence is returned by
      // the runner either way, so the oldest item is discarded and counted instead of thrown.
      if (queue.length >= maxQueueSize) {
        queue.shift()
        dropped += 1
      }
      queue.push(evidence)
    },
    complete() {
      completed = true
      finishWaiters()
    },
    next() {
      const evidence = queue.shift()
      if (evidence !== undefined) return Promise.resolve({ done: false, value: evidence })
      if (completed) return Promise.resolve({ done: true, value: undefined })
      return new Promise<IteratorResult<AgentStepEvidence>>((resolve) => waiters.push(resolve))
    },
    return() {
      queue.length = 0
      completed = true
      finishWaiters()
      return Promise.resolve({ done: true, value: undefined })
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  return stream
}

// ---------------------------------------------------------------------------
// Resumable evidence log
// ---------------------------------------------------------------------------

/** One turn's replayable evidence view - see {@link AgentEvidenceLog.replay}. */
export interface AgentEvidenceReplay {
  /** Evidence already recorded with `seq` greater than the requested cursor, in order. */
  readonly evidence: readonly AgentStepEvidence[]
  /** Live continuation while the turn is still running; `undefined` once it has finished. */
  readonly live: AgentEvidenceStream | undefined
  /** Resolves with the value passed to {@link AgentEvidenceLog.finish} when the turn ends. */
  readonly result: Promise<unknown>
}

/**
 * Seam for resumable evidence streams. An HTTP seam records one turn's step evidence through
 * `open`, stores the terminal wire frame through `finish`, and serves SSE reconnects through
 * `replay` (`Last-Event-ID` maps to evidence `seq`). The stored result value is opaque to the log -
 * each seam stores whatever it needs to re-emit its own terminal frames.
 *
 * {@link createMemoryAgentEvidenceLog} is the single-process dev/test reference; a durable,
 * multi-process log is an adapter concern behind the same interface.
 */
export interface AgentEvidenceLog {
  /**
   * Telemetry port recording one turn's evidence - combine it into `ports.telemetry` with
   * `combineAgentTelemetry`. Opening a finished turn reopens it (a resume of a suspended run):
   * evidence keeps appending and late replays await the new result.
   */
  open(turnId: string): AgentTelemetryPort
  /** Mark the turn finished: live replays complete and `result` is stored for late reconnects. */
  finish(turnId: string, result: unknown): void | Promise<void>
  /** The turn's evidence after `afterSeq`, or `undefined` for an unknown turn. */
  replay(
    turnId: string,
    afterSeq: number,
  ): AgentEvidenceReplay | undefined | Promise<AgentEvidenceReplay | undefined>
}

export interface MemoryAgentEvidenceLogOptions {
  /** Maximum retained turns; the oldest turn is evicted when a new one opens. Default 256. */
  readonly maxTurns?: number
}

interface MemoryTurnRecord {
  readonly evidence: AgentStepEvidence[]
  finished: boolean
  resultPromise: Promise<unknown>
  resolveResult: (value: unknown) => void
  readonly subscribers: Set<AgentEvidenceStream>
}

/**
 * In-memory {@link AgentEvidenceLog} reference for local development and tests. Single-process by
 * construction: replay only sees runs recorded by this instance. Retention is bounded by
 * `maxTurns` with oldest-first eviction, so a reconnect to an evicted turn reports
 * replay-unavailable rather than growing memory without bound.
 */
export function createMemoryAgentEvidenceLog(
  options: MemoryAgentEvidenceLogOptions = {},
): AgentEvidenceLog {
  const maxTurns = options.maxTurns ?? 256
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1)
    throw new RangeError("agent evidence log: maxTurns must be a positive safe integer")
  const turns = new Map<string, MemoryTurnRecord>()

  const deferred = (record: MemoryTurnRecord): void => {
    record.resultPromise = new Promise<unknown>((resolve) => {
      record.resolveResult = resolve
    })
  }

  return {
    open(turnId) {
      let turn = turns.get(turnId)
      if (turn === undefined) {
        while (turns.size >= maxTurns) {
          const oldest = turns.keys().next().value
          if (oldest === undefined) break
          turns.delete(oldest)
        }
        turn = {
          evidence: [],
          finished: false,
          resultPromise: Promise.resolve(undefined),
          resolveResult: () => {},
          subscribers: new Set(),
        }
        deferred(turn)
        turns.set(turnId, turn)
      } else if (turn.finished) {
        // A resume reopens the turn: the next finish() resolves a fresh result for new replays.
        turn.finished = false
        deferred(turn)
      }
      const opened = turn
      return {
        step(evidence) {
          opened.evidence.push(evidence)
          for (const subscriber of opened.subscribers) subscriber.step(evidence)
        },
      }
    },
    finish(turnId, result) {
      const turn = turns.get(turnId)
      if (turn === undefined || turn.finished) return
      turn.finished = true
      turn.resolveResult(result)
      for (const subscriber of turn.subscribers) subscriber.complete()
      turn.subscribers.clear()
    },
    replay(turnId, afterSeq) {
      const turn = turns.get(turnId)
      if (turn === undefined) return undefined
      const evidence = turn.evidence.filter((item) => item.seq > afterSeq)
      if (turn.finished) return { evidence, live: undefined, result: turn.resultPromise }
      // Snapshot and subscribe in the same synchronous step, so no evidence item can land between
      // the filtered history and the live stream.
      const live = createAgentEvidenceStream()
      turn.subscribers.add(live)
      return { evidence, live, result: turn.resultPromise }
    },
  }
}

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

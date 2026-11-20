/**
 * A trivial in-memory pub/sub for `subscription` resolvers - the reference implementation of the
 * subscription source seam. A resolver's `subscribe` returns `pubsub.subscribe(topic)` (an async
 * iterator); anything in the process calls `pubsub.publish(topic, payload)` to push an event.
 *
 * This is deliberately in-process and unbounded-fan-in only within one server instance - the same
 * single-instance contract as core's `TopicRegistry`. A durable, multi-instance, or tenant-scoped
 * pub/sub (Redis, a Durable Object, NATS) is an operated concern: implement the same
 * `{ publish, subscribe }` shape over your bus and pass it in. Keeping only the in-memory impl here is
 * the guardrail - a durable payload-carrying sink does not belong in a public package.
 */

/** The subscription source shape a resolver's `subscribe` consumes. Swap the impl for a durable bus. */
export interface GraphqlPubSub<Event = unknown> {
  /** Push `payload` to every open iterator on `topic`. */
  publish(topic: string, payload: Event): void
  /** An async iterator that yields each future `publish(topic, ...)` until it is returned/closed. */
  subscribe(topic: string): AsyncIterableIterator<Event>
}

export interface GraphqlPubSubOptions {
  /** Maximum queued events per subscriber. Positive safe integer; default 1024. */
  readonly maxQueuedEvents?: number
  /** A full queue closes with an error by default. Dropping requires explicit opt-in. */
  readonly overflow?: "error" | "drop-oldest" | "drop-newest"
}

export class GraphqlPubSubOverflowError extends Error {
  readonly code = "graphql_pubsub_overflow"

  constructor() {
    super("GraphQL subscription event queue is full")
    this.name = "GraphqlPubSubOverflowError"
  }
}

/** Create an in-memory {@link GraphqlPubSub} with finite subscriber queues. */
export function createPubSub<Event = unknown>(
  options: GraphqlPubSubOptions = {},
): GraphqlPubSub<Event> {
  const maxQueuedEvents = options.maxQueuedEvents ?? 1024
  const overflow = options.overflow ?? "error"
  if (!Number.isSafeInteger(maxQueuedEvents) || maxQueuedEvents < 1) {
    throw new RangeError("createPubSub maxQueuedEvents must be a positive safe integer")
  }
  if (overflow !== "error" && overflow !== "drop-oldest" && overflow !== "drop-newest") {
    throw new TypeError("createPubSub overflow must be error, drop-oldest or drop-newest")
  }
  const topics = new Map<string, Set<Sink<Event>>>()

  const publish = (topic: string, payload: Event): void => {
    const sinks = topics.get(topic)
    if (sinks === undefined) return
    for (const sink of sinks) sink.push(payload)
  }

  const subscribe = (topic: string): AsyncIterableIterator<Event> => {
    let sinks = topics.get(topic)
    if (sinks === undefined) {
      sinks = new Set()
      topics.set(topic, sinks)
    }
    const set = sinks
    const sink = createSink<Event>(maxQueuedEvents, overflow, () => {
      set.delete(sink)
      if (set.size === 0) topics.delete(topic)
    })
    set.add(sink)
    return sink.iterator
  }

  return { publish, subscribe }
}

/** Awaiting pulls consume immediately; synchronous publish cannot provide producer backpressure. */
interface Sink<Event> {
  push(payload: Event): void
  readonly iterator: AsyncIterableIterator<Event>
}

function createSink<Event>(
  maxQueuedEvents: number,
  overflow: NonNullable<GraphqlPubSubOptions["overflow"]>,
  onClose: () => void,
): Sink<Event> {
  let queue: (Event | undefined)[] = []
  let queueHead = 0
  let queueSize = 0
  let pulls: (((result: IteratorResult<Event>) => void) | undefined)[] = []
  let pullsHead = 0
  let done = false
  let failure: GraphqlPubSubOverflowError | undefined

  const shiftQueue = (): Event => {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: callers shift only while queueSize > 0, so the head slot holds an Event (undefined is itself a valid payload).
    const value = queue[queueHead] as Event
    queue[queueHead] = undefined
    queueHead++
    queueSize--
    if (queueSize === 0) {
      queue.length = 0
      queueHead = 0
    } else if (queueHead >= 64 && queueHead * 2 >= queue.length) {
      queue = queue.slice(queueHead)
      queueHead = 0
    }
    return value
  }

  const shiftPull = (): ((result: IteratorResult<Event>) => void) | undefined => {
    if (pullsHead >= pulls.length) return undefined
    const pull = pulls[pullsHead]
    pulls[pullsHead] = undefined
    pullsHead++
    if (pullsHead >= pulls.length) {
      pulls.length = 0
      pullsHead = 0
    } else if (pullsHead >= 64 && pullsHead * 2 >= pulls.length) {
      pulls = pulls.slice(pullsHead)
      pullsHead = 0
    }
    return pull
  }

  const push = (payload: Event): void => {
    if (done) return
    const pull = shiftPull()
    if (pull !== undefined) {
      pull({ value: payload, done: false })
      return
    }
    if (queueSize >= maxQueuedEvents) {
      if (overflow === "drop-newest") return
      if (overflow === "error") {
        failure = new GraphqlPubSubOverflowError()
        finish()
        return
      }
      shiftQueue()
    }
    queue.push(payload)
    queueSize++
  }

  const finish = (): IteratorResult<Event> => {
    if (!done) {
      done = true
      queue.length = 0
      queueHead = 0
      queueSize = 0
      onClose()
      for (let i = pullsHead; i < pulls.length; i++) {
        pulls[i]?.({ value: undefined, done: true })
      }
      pulls.length = 0
      pullsHead = 0
    }
    return { value: undefined, done: true }
  }

  const iterator: AsyncIterableIterator<Event> = {
    next(): Promise<IteratorResult<Event>> {
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        return Promise.reject(error)
      }
      if (done) return Promise.resolve({ value: undefined, done: true })
      if (queueSize > 0) return Promise.resolve({ value: shiftQueue(), done: false })
      return new Promise((resolve) => pulls.push(resolve))
    },
    return(): Promise<IteratorResult<Event>> {
      failure = undefined
      return Promise.resolve(finish())
    },
    throw(err?: unknown): Promise<IteratorResult<Event>> {
      failure = undefined
      finish()
      return Promise.reject(err)
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }

  return { push, iterator }
}

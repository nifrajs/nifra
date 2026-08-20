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

/** Create an in-memory {@link GraphqlPubSub}. */
export function createPubSub<Event = unknown>(): GraphqlPubSub<Event> {
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
    const sink = createSink<Event>(() => {
      set.delete(sink)
      if (set.size === 0) topics.delete(topic)
    })
    set.add(sink)
    return sink.iterator
  }

  return { publish, subscribe }
}

/** One subscriber: a bounded push queue bridged to an async iterator with backpressure via awaiting pulls. */
interface Sink<Event> {
  push(payload: Event): void
  readonly iterator: AsyncIterableIterator<Event>
}

function createSink<Event>(onClose: () => void): Sink<Event> {
  const queue: Event[] = []
  const pulls: Array<(result: IteratorResult<Event>) => void> = []
  let done = false

  const push = (payload: Event): void => {
    if (done) return
    const pull = pulls.shift()
    if (pull !== undefined) {
      pull({ value: payload, done: false })
      return
    }
    queue.push(payload)
  }

  const finish = (): IteratorResult<Event> => {
    if (!done) {
      done = true
      onClose()
      for (const pull of pulls.splice(0)) pull({ value: undefined, done: true })
    }
    return { value: undefined, done: true }
  }

  const iterator: AsyncIterableIterator<Event> = {
    next(): Promise<IteratorResult<Event>> {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift() as Event, done: false })
      if (done) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve) => pulls.push(resolve))
    },
    return(): Promise<IteratorResult<Event>> {
      return Promise.resolve(finish())
    },
    throw(err?: unknown): Promise<IteratorResult<Event>> {
      finish()
      return Promise.reject(err)
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }

  return { push, iterator }
}

/** Typed, runtime-neutral channel contracts. Durable replay, presence, fan-out, and tenant-aware
 * routing belong in an adapter; the bundled hub provides only bounded process-local replay for tests
 * and local development. */

export interface ChannelContract<Name extends string, Message> {
  readonly name: Name
  /** Type-only message witness; adapters never materialize it. */
  readonly __message?: (value: Message) => Message
}

export interface ChannelEvent<Message> {
  /** Monotonic within one channel; adapters may use a different opaque cursor representation. */
  readonly sequence: number
  readonly resumeToken: string
  readonly data: Message
}

export type ChannelCloseReason = "closed" | "backpressure" | "aborted"

export interface ChannelSubscription<Message> extends AsyncIterableIterator<ChannelEvent<Message>> {
  readonly channel: string
  readonly closed: boolean
  readonly closeReason: ChannelCloseReason | undefined
  readonly resumeToken: string | undefined
  close(): void
}

export interface ChannelSubscribeOptions {
  /** Maximum undelivered events retained for this subscriber. Default 64. */
  readonly maxQueue?: number
  /** Resume after this opaque cursor. The adapter must fail closed when the cursor is unavailable. */
  readonly resumeFrom?: string
  readonly signal?: AbortSignal
}

export interface ChannelHub {
  subscribe<Name extends string, Message>(
    channel: ChannelContract<Name, Message>,
    options?: ChannelSubscribeOptions,
  ): ChannelSubscription<Message>
  publish<Name extends string, Message>(
    channel: ChannelContract<Name, Message>,
    data: Message,
  ): ChannelEvent<Message>
}

export interface MemoryChannelHubOptions {
  /** Default queue bound per subscriber. Default 64. */
  readonly maxQueue?: number
  /** Maximum events retained per channel for local cursor replay. Default: the queue bound. */
  readonly historySize?: number
}

/** A requested cursor is malformed, belongs to another channel, or fell outside retained history. */
export class ChannelResumeUnavailableError extends Error {
  readonly channel: string
  readonly resumeToken: string

  constructor(channel: string, resumeToken: string) {
    super("channel: resume cursor is unavailable")
    this.name = "ChannelResumeUnavailableError"
    this.channel = channel
    this.resumeToken = resumeToken
  }
}

function validName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/.test(name)
}

/** Define a typed channel name. Message types are erased; adapters own validation at their boundary. */
export function defineChannel<Name extends string, Message>(
  name: Name,
): ChannelContract<Name, Message> {
  if (!validName(name)) throw new TypeError("channel: name must be a bounded token")
  return Object.freeze({ name })
}

type Waiter<Message> = (result: IteratorResult<ChannelEvent<Message>>) => void

class MemorySubscription<Message> implements ChannelSubscription<Message> {
  readonly channel: string
  private readonly maxQueue: number
  private readonly remove: () => void
  private readonly queue: ChannelEvent<Message>[] = []
  private readonly waiters: Waiter<Message>[] = []
  private isClosed = false
  private reason: ChannelCloseReason | undefined
  private lastToken: string | undefined
  private abortSignal: AbortSignal | undefined
  private abortHandler: (() => void) | undefined

  constructor(channel: string, maxQueue: number, remove: () => void) {
    this.channel = channel
    this.maxQueue = maxQueue
    this.remove = remove
  }

  seed(events: readonly ChannelEvent<Message>[]): void {
    if (events.length > this.maxQueue) {
      throw new RangeError("channel: resume history exceeds subscriber queue bound")
    }
    this.queue.push(...events)
  }

  attachSignal(signal: AbortSignal | undefined): void {
    if (signal === undefined || this.isClosed) return
    const handler = (): void => this.close("aborted")
    this.abortSignal = signal
    this.abortHandler = handler
    signal.addEventListener("abort", handler, { once: true })
    // Check after registration as well: an abort can happen between the initial caller check and
    // listener registration in host implementations. `close()` removes the listener again.
    if (signal.aborted) this.close("aborted")
  }

  get closed(): boolean {
    return this.isClosed
  }

  get closeReason(): ChannelCloseReason | undefined {
    return this.reason
  }

  get resumeToken(): string | undefined {
    return this.lastToken
  }

  push(event: ChannelEvent<Message>): void {
    if (this.isClosed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      this.lastToken = event.resumeToken
      waiter({ done: false, value: event })
      return
    }
    if (this.queue.length >= this.maxQueue) {
      this.close("backpressure")
      return
    }
    this.queue.push(event)
  }

  next(): Promise<IteratorResult<ChannelEvent<Message>>> {
    const event = this.queue.shift()
    if (event !== undefined) {
      this.lastToken = event.resumeToken
      return Promise.resolve({ done: false, value: event })
    }
    if (this.isClosed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  return(): Promise<IteratorResult<ChannelEvent<Message>>> {
    this.close("closed")
    return Promise.resolve({ done: true, value: undefined })
  }

  close(reason: ChannelCloseReason = "closed"): void {
    if (this.isClosed) return
    this.isClosed = true
    this.reason = reason
    this.queue.length = 0
    if (this.abortSignal !== undefined && this.abortHandler !== undefined) {
      this.abortSignal.removeEventListener("abort", this.abortHandler)
      this.abortSignal = undefined
      this.abortHandler = undefined
    }
    this.remove()
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ChannelEvent<Message>> {
    return this
  }
}

/** A bounded in-memory hub suitable for tests and local development, never for durable fan-out. */
export function memoryChannelHub(options: MemoryChannelHubOptions = {}): ChannelHub {
  const maxQueue = options.maxQueue ?? 64
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) {
    throw new RangeError("channel: maxQueue must be a positive safe integer")
  }
  const historySize = options.historySize ?? maxQueue
  if (!Number.isSafeInteger(historySize) || historySize < 0) {
    throw new RangeError("channel: historySize must be a non-negative safe integer")
  }
  const subscribers = new Map<string, Set<MemorySubscription<unknown>>>()
  const sequences = new Map<string, number>()
  const history = new Map<string, ChannelEvent<unknown>[]>()

  const tokenFor = (channel: string, sequence: number): string =>
    `${channel}:${sequence.toString(36)}`

  const sequenceOf = (channel: string, token: string): number | undefined => {
    const prefix = `${channel}:`
    if (!token.startsWith(prefix)) return undefined
    const digits = token.slice(prefix.length)
    if (!/^[0-9a-z]+$/.test(digits)) return undefined
    const sequence = Number.parseInt(digits, 36)
    return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined
  }

  return {
    subscribe<Name extends string, Message>(
      channel: ChannelContract<Name, Message>,
      subscriptionOptions: ChannelSubscribeOptions = {},
    ): ChannelSubscription<Message> {
      const queue = subscriptionOptions.maxQueue ?? maxQueue
      if (!Number.isSafeInteger(queue) || queue < 1) {
        throw new RangeError("channel: maxQueue must be a positive safe integer")
      }
      const currentSequence = sequences.get(channel.name) ?? 0
      const resumeFrom = subscriptionOptions.resumeFrom
      let replay: readonly ChannelEvent<unknown>[] = []
      if (resumeFrom !== undefined) {
        const requestedSequence = sequenceOf(channel.name, resumeFrom)
        const channelHistory = history.get(channel.name) ?? []
        const oldest = channelHistory[0]?.sequence
        const known =
          requestedSequence !== undefined &&
          requestedSequence <= currentSequence &&
          (requestedSequence === currentSequence ||
            channelHistory.some((event) => event.sequence === requestedSequence))
        if (!known) throw new ChannelResumeUnavailableError(channel.name, resumeFrom)
        replay = channelHistory.filter((event) => event.sequence > requestedSequence)
        // Keep this explicit so a future history representation cannot silently truncate a resume.
        if (oldest !== undefined && requestedSequence < oldest && replay.length === 0) {
          throw new ChannelResumeUnavailableError(channel.name, resumeFrom)
        }
        if (replay.length > queue) {
          throw new ChannelResumeUnavailableError(channel.name, resumeFrom)
        }
      }
      let members = subscribers.get(channel.name)
      if (members === undefined) {
        members = new Set()
        subscribers.set(channel.name, members)
      }
      let subscription: MemorySubscription<unknown>
      const remove = (): void => {
        members?.delete(subscription)
        if (members?.size === 0) subscribers.delete(channel.name)
      }
      subscription = new MemorySubscription(channel.name, queue, remove)
      subscription.seed(replay)
      members.add(subscription)
      subscription.attachSignal(subscriptionOptions.signal)
      return subscription as unknown as ChannelSubscription<Message>
    },
    publish<Name extends string, Message>(
      channel: ChannelContract<Name, Message>,
      data: Message,
    ): ChannelEvent<Message> {
      const previous = sequences.get(channel.name) ?? 0
      if (previous === Number.MAX_SAFE_INTEGER) {
        throw new RangeError("channel: sequence space exhausted")
      }
      const sequence = previous + 1
      sequences.set(channel.name, sequence)
      const event: ChannelEvent<Message> = {
        sequence,
        resumeToken: tokenFor(channel.name, sequence),
        data,
      }
      if (historySize > 0) {
        const channelHistory = history.get(channel.name) ?? []
        channelHistory.push(event as unknown as ChannelEvent<unknown>)
        if (channelHistory.length > historySize) channelHistory.shift()
        history.set(channel.name, channelHistory)
      }
      for (const subscriber of subscribers.get(channel.name) ?? []) {
        subscriber.push(event as unknown as ChannelEvent<unknown>)
      }
      return event
    },
  }
}

/** Adapt a channel subscription to a cancellable Web stream for SSE/HTTP adapters. */
export function channelReadableStream<Message>(
  subscription: ChannelSubscription<Message>,
): ReadableStream<ChannelEvent<Message>> {
  const iterator = subscription[Symbol.asyncIterator]()
  return new ReadableStream<ChannelEvent<Message>>({
    async pull(controller) {
      try {
        const result = await iterator.next()
        if (result.done) controller.close()
        else controller.enqueue(result.value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      subscription.close()
    },
  })
}

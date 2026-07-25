/**
 * `@nifrajs/web/fn-state` - the pending/error state around a server-function call.
 *
 * Calling a server function needs no binding: the client stub is `(input) => Promise<Output>`, and a
 * click handler can await it. What a component usually wants on top is whether a call is in flight,
 * what came back, and what went wrong - which is state, and state is the part every framework spells
 * differently.
 *
 * So the state machine lives here, framework-agnostic, and each adapter contributes only its
 * subscription primitive. Five copies of "is it pending" would drift, and the drift would be five
 * subtly different answers to the same question.
 *
 * ## Two behaviours worth stating
 *
 * **The last call wins.** Concurrent calls are not queued or cancelled; a response that is no longer
 * the newest is discarded rather than written. Without that, a slow first call landing after a fast
 * second one would overwrite fresh data with stale - the classic out-of-order bug, and one that only
 * appears under load, which is to say in production.
 *
 * **`call` still rejects.** The error is recorded for rendering AND the promise rejects, so `await`
 * behaves the way `await` should and a caller who wants to branch can. A caller who only renders from
 * state should attach a `.catch(() => {})`, the same as `useFetcher`'s `submit`.
 */

/** What a component renders from. */
export interface ServerFnState<Output> {
  /** A call is in flight. */
  readonly pending: boolean
  /** The most recent successful result, kept across a later pending call so the UI need not flicker. */
  readonly data: Output | undefined
  /** The most recent failure, cleared when a call succeeds. */
  readonly error: Error | undefined
}

/** A subscribable call site. One per component instance, created by the framework binding. */
export interface ServerFnStore<Input, Output> {
  /** Register a listener; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /**
   * The current state. The SAME object is returned until something changes, because
   * `useSyncExternalStore` and its equivalents compare by reference - a fresh object each call is an
   * infinite render loop.
   */
  snapshot(): ServerFnState<Output>
  /** Invoke the server function. Records state, and rejects on failure. */
  call(input: Input): Promise<Output>
  /** Back to idle, discarding data and error. */
  reset(): void
}

const IDLE: ServerFnState<never> = { pending: false, data: undefined, error: undefined }

/** The idle state, shared so a server render and the first client render agree by reference. */
export function idleServerFnState<Output>(): ServerFnState<Output> {
  return IDLE as ServerFnState<Output>
}

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause), { cause })

/**
 * Wrap a server function (or any async function) in a subscribable pending/error state.
 *
 * Framework-free by design: the adapters call this and subscribe with their own primitive.
 */
export function createServerFnStore<Input, Output>(
  fn: (input: Input) => Promise<Output> | Output,
): ServerFnStore<Input, Output> {
  const listeners = new Set<() => void>()
  let state: ServerFnState<Output> = idleServerFnState<Output>()
  /** Identifies the newest call, so an older one landing later cannot write over it. */
  let generation = 0

  const set = (next: ServerFnState<Output>): void => {
    state = next
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => state,
    async call(input) {
      const mine = ++generation
      // `data` is deliberately kept while pending: dropping it makes a list blank on every refetch.
      set({ pending: true, data: state.data, error: undefined })
      try {
        const data = await fn(input)
        if (mine === generation) set({ pending: false, data, error: undefined })
        return data
      } catch (cause) {
        const error = asError(cause)
        if (mine === generation) set({ pending: false, data: state.data, error })
        throw error
      }
    },
    reset() {
      // Bump the generation so a call already in flight cannot resurrect the state it was reset from.
      generation += 1
      set(idleServerFnState<Output>())
    },
  }
}

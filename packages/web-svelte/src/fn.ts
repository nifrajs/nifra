/**
 * `@nifrajs/web-svelte/fn` - Svelte binding for a server function's pending/error state.
 *
 * Calling a server function needs no hook: the client stub is `(input) => Promise<Output>`. This adds
 * the part a component usually wants around it - in flight, last result, last error - and nothing more.
 *
 * The state machine is `@nifrajs/web`'s `createServerFnStore`, shared with every other adapter, so
 * "is it pending" has one answer rather than five that drift. This file contributes only a `readable` fed by the store.
 */

import type { ClientServerFn, ServerFnReference } from "@nifrajs/web/fn"
import { createServerFnStore, idleServerFnState, type ServerFnState } from "@nifrajs/web/fn-state"
import { type Readable, readable } from "svelte/store"

/** A server function's readable state plus the call itself. */
export interface ServerFnHandle<Input, Output> {
  /** Reactive state; subscribe with `$state` in a component. */
  readonly state: Readable<ServerFnState<Output>>
  /** Invoke it. Records state, and rejects on failure - attach `.catch` if you only render state. */
  readonly call: (input: Input) => Promise<Output>
  /** Back to idle. */
  readonly reset: () => void
}

/**
 * Track one server function's call state.
 *
 * The `readable` subscribes on first use and unsubscribes when the last subscriber leaves, so a
 * component that never reads the state never attaches a listener.
 */
export function useServerFn<Input, Output>(
  fn: ServerFnReference<Input, Output>,
): ServerFnHandle<Input, Output> {
  const store = createServerFnStore(fn as ClientServerFn<Input, Output>)
  const state = readable<ServerFnState<Output>>(idleServerFnState<Output>(), (set) => {
    // Prime before subscribing, exactly as `useFetcher` does in this package. `readable` runs this
    // start function only on the FIRST subscription, so without the snapshot a store attached after a
    // call has already run reports its initial value - idle - for a call that finished. The four
    // sibling adapters read a snapshot on mount, so skipping it here made Svelte the one place where
    // "is it pending" disagreed with the shared state machine it exists to report.
    set(store.snapshot())
    return store.subscribe(() => set(store.snapshot()))
  })
  return { state, call: store.call, reset: store.reset }
}

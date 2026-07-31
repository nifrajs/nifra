/**
 * `@nifrajs/web-vue/fn` - Vue binding for a server function's pending/error state.
 *
 * Calling a server function needs no hook: the client stub is `(input) => Promise<Output>`. This adds
 * the part a component usually wants around it - in flight, last result, last error - and nothing more.
 *
 * The state machine is `@nifrajs/web`'s `createServerFnStore`, shared with every other adapter, so
 * "is it pending" has one answer rather than five that drift. This file contributes only a `shallowRef` fed by the store.
 */

import type { ClientServerFn, ServerFnReference } from "@nifrajs/web/fn"
import { createServerFnStore, type ServerFnState } from "@nifrajs/web/fn-state"
import { onScopeDispose, type ShallowRef, shallowRef } from "vue"

/** A server function's state ref plus the call itself. */
export interface ServerFnHandle<Input, Output> {
  /** Reactive state; read `.value` in a template or computed. */
  readonly state: ShallowRef<ServerFnState<Output>>
  /** Invoke it. Records state, and rejects on failure - attach `.catch` if you only render state. */
  readonly call: (input: Input) => Promise<Output>
  /** Back to idle. */
  readonly reset: () => void
}

/**
 * Track one server function's call state.
 *
 * `shallowRef` rather than `ref`: the state object is replaced wholesale on every change, so deep
 * reactivity would walk the payload on each update for nothing.
 */
export function useServerFn<Input, Output>(
  fn: ServerFnReference<Input, Output>,
): ServerFnHandle<Input, Output> {
  const store = createServerFnStore(fn as ClientServerFn<Input, Output>)
  // Seeded from the store, not from the idle constant. They are the same value here - the store is
  // created one line up and cannot have moved - so this is correctness that does not depend on that
  // staying true. Svelte had exactly this line reading the constant, and when its subscription turned
  // out to be lazy the first render showed idle for a call that had already finished.
  const state = shallowRef<ServerFnState<Output>>(store.snapshot())
  onScopeDispose(
    store.subscribe(() => {
      state.value = store.snapshot()
    }),
  )
  return { state, call: store.call, reset: store.reset }
}

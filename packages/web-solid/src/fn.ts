/**
 * `@nifrajs/web-solid/fn` - Solid binding for a server function's pending/error state.
 *
 * Calling a server function needs no hook: the client stub is `(input) => Promise<Output>`. This adds
 * the part a component usually wants around it - in flight, last result, last error - and nothing more.
 *
 * The state machine is `@nifrajs/web`'s `createServerFnStore`, shared with every other adapter, so
 * "is it pending" has one answer rather than five that drift. This file contributes only a signal fed by the store.
 */
import { createServerFnStore, type ServerFnState } from "@nifrajs/web/fn-state"
import { type Accessor, createSignal, onCleanup } from "solid-js"

/** A server function's state accessor plus the call itself. */
export interface ServerFnHandle<Input, Output> {
  /** Reactive state - read it inside JSX so Solid tracks it. */
  readonly state: Accessor<ServerFnState<Output>>
  /** Invoke it. Records state, and rejects on failure - attach `.catch` if you only render state. */
  readonly call: (input: Input) => Promise<Output>
  /** Back to idle. */
  readonly reset: () => void
}

/**
 * Track one server function's call state.
 *
 *     const addTodo = useServerFn(fns.addTodo)
 *     <button disabled={addTodo.state().pending} onClick={() => addTodo.call({ text }).catch(() => {})}>
 */
export function useServerFn<Input, Output>(
  fn: (input: Input) => Promise<Output> | Output,
): ServerFnHandle<Input, Output> {
  const store = createServerFnStore(fn)
  // Seeded from the store, not from the idle constant. They are the same value here - the store is
  // created one line up and cannot have moved - so this is correctness that does not depend on that
  // staying true. Svelte had exactly this line reading the constant, and when its subscription turned
  // out to be lazy the first render showed idle for a call that had already finished.
  const [state, setState] = createSignal<ServerFnState<Output>>(store.snapshot())
  onCleanup(store.subscribe(() => setState(() => store.snapshot())))
  return { state, call: store.call, reset: store.reset }
}

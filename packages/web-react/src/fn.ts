/**
 * `@nifrajs/web-react/fn` - React binding for a server function's pending/error state.
 *
 * Calling a server function needs no hook: the client stub is `(input) => Promise<Output>`. This adds
 * the part a component usually wants around it - in flight, last result, last error - and nothing more.
 *
 * The state machine is `@nifrajs/web`'s `createServerFnStore`, shared with every other adapter, so
 * "is it pending" has one answer rather than five that drift. This file contributes only the `useSyncExternalStore` subscription.
 */
import { createServerFnStore, type ServerFnState } from "@nifrajs/web/fn-state"
import { useMemo, useRef, useSyncExternalStore } from "react"

/** A server function's state plus the call itself. */
export interface ServerFnHandle<Input, Output> extends ServerFnState<Output> {
  /** Invoke it. Records state, and rejects on failure - attach `.catch` if you only render state. */
  readonly call: (input: Input) => Promise<Output>
  /** Back to idle. */
  readonly reset: () => void
}

/**
 * Track one server function's call state.
 *
 *     const addTodo = useServerFn(fns.addTodo)
 *     <button disabled={addTodo.pending} onClick={() => addTodo.call({ text }).catch(() => {})}>
 *
 * The store is per component instance and created once; `fn` is read on the first render only, so a
 * freshly-created inline function neither resets the state nor goes stale.
 */
export function useServerFn<Input, Output>(
  fn: (input: Input) => Promise<Output> | Output,
): ServerFnHandle<Input, Output> {
  // The store is created once, but always calls the CURRENT `fn`. Capturing `fn` directly would
  // either recreate the store on every render (losing the state) or hold the first render's closure
  // (calling a stale one); the ref is what makes "created once" and "never stale" both true.
  const latest = useRef(fn)
  latest.current = fn
  const store = useMemo(() => createServerFnStore((input: Input) => latest.current(input)), [])
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  return { ...state, call: store.call, reset: store.reset }
}

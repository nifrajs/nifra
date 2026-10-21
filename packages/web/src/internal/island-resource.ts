import { adopt } from "./island-owner.ts"
import { effect, signal, untrack } from "./island-signals.ts"

/** An async value's state. `status` narrows `value` and `error`, so no branch can be skipped. */
export type ResourceState<T> =
  | { readonly status: "pending"; readonly value: undefined; readonly error: undefined }
  | { readonly status: "ready"; readonly value: T; readonly error: undefined }
  | { readonly status: "error"; readonly value: undefined; readonly error: unknown }

/** Call it to read the current state (tracking, like a signal). */
export type Resource<T> = {
  (): ResourceState<T>
  /** Fetch the current key again; once disposed, nothing. */
  refetch(): void
  /** Stop refetching and abort the request in flight; its result is dropped. */
  dispose(): void
}

const PENDING = { status: "pending", value: undefined, error: undefined } as const

/**
 * An async value keyed by `source`. `source` runs tracked, so a write to any signal it reads starts a
 * new fetch; `fetcher` runs untracked with that key, so nothing it reads (before or after an `await`)
 * is a dependency. A newer fetch aborts the older one and only the newest result lands. Inside an
 * island, unmounting disposes it: the request in flight is aborted and its late result dropped.
 */
export function resource<K, T>(
  source: () => K,
  fetcher: (key: K, abort: AbortSignal) => Promise<T>,
): Resource<T> {
  const state = signal<ResourceState<T>>(PENDING)
  let generation = 0
  let live = true
  let controller: AbortController | undefined
  let key: K
  const run = (): void => {
    const mine = ++generation
    controller?.abort()
    const active = new AbortController()
    controller = active
    state.set(PENDING)
    let pending: Promise<T>
    try {
      pending = fetcher(key, active.signal)
    } catch (error) {
      pending = Promise.reject(error)
    }
    pending.then(
      (value) => {
        if (mine === generation) state.set({ status: "ready", value, error: undefined })
      },
      (error) => {
        // A superseded or aborted fetch is not an error the reader should see.
        if (mine === generation && !active.signal.aborted)
          state.set({ status: "error", value: undefined, error })
      },
    )
  }
  const stop = effect(() => {
    key = source()
    untrack(run)
  })
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `refetch` and `dispose` are assigned below
  const read = (() => state()) as Resource<T>
  read.refetch = () => {
    if (live) untrack(run)
  }
  read.dispose = () => {
    live = false
    stop()
    generation++
    controller?.abort()
  }
  adopt(read.dispose)
  return read
}

/**
 * `readDeferred` — Preact's analogue of React 19's `use()` for a deferred promise (preact/compat has
 * no `use`). Reads a React-style tagged thenable synchronously: returns the value if fulfilled, throws
 * the reason if rejected, else throws the promise so `<Suspense>` awaits it. The core tags
 * `status`/`value`/`reason` via the streamed `__nifraResolve`/`__nifraReject`; this also self-tags on
 * settle so a server re-render (which has no `__nifraResolve`) reads "fulfilled" and stops re-throwing
 * the already-resolved promise. Pure + isomorphic — no `preact` import, so it unit-tests directly.
 */
export type Thenable<T> = Promise<T> & {
  status?: "pending" | "fulfilled" | "rejected"
  value?: T
  reason?: unknown
}

export function readDeferred<T>(promise: Thenable<T>): T {
  if (promise.status === "fulfilled") return promise.value as T
  if (promise.status === "rejected") throw promise.reason
  if (promise.status === undefined) {
    promise.status = "pending"
    promise.then(
      (v) => {
        promise.status = "fulfilled"
        promise.value = v
      },
      (e) => {
        promise.status = "rejected"
        promise.reason = e
      },
    )
  }
  throw promise // pending — <Suspense> awaits it; the self-tag above wakes the re-render.
}

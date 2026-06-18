import type { Deferred } from "@nifrajs/web"
/**
 * `@nifrajs/web-vue/await` — the `<Await>` primitive for deferred loader/action data (`defer()`), as a Vue
 * component consumed with scoped slots: `default` (the resolved value), `fallback`, and `error`.
 *
 * Vue's SSR resolves async deps before flushing, so a `<Suspense>`-based Await would *block* the stream
 * (defeating `defer()`'s non-blocking point). Instead this renders the `fallback` on the server and
 * resolves the deferred **reactively on the client** (`onMounted` → the registry promise the core
 * streamed via `__nifraResolve` settles → re-render). Trade-off vs React/Preact (which stream the
 * resolved content into the SSR HTML): with JS off, Vue shows the fallback for deferred content —
 * acceptable since deferred data is non-critical by design (critical data is the loader proper). The
 * deferred value still arrives correctly on the client (hydration + soft nav).
 */
import { defineComponent, shallowRef, type VNode, watch } from "vue"

function isDeferred(value: unknown): value is Deferred<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __nifra_deferred?: unknown }).__nifra_deferred === true
  )
}

// 0 = pending (show fallback), 1 = fulfilled (show default(value)), 2 = rejected (show error(reason)).
type AwaitState = { phase: 0 | 1 | 2; value?: unknown; error?: unknown }

/**
 * `<Await :resolve="deferredOrValue">` with scoped slots `default(value)`, `fallback()`, `error(err)`.
 * An already-resolved `resolve` (a plain value, or a client navigation that awaited it) renders
 * `default` immediately. A `Deferred` renders `fallback` until it settles on the client.
 */
export const Await = defineComponent({
  name: "Await",
  // `required` with no `type` accepts any value (Deferred<T> | T) — the call site types it.
  props: { resolve: { required: true as const } },
  setup(props, { slots }) {
    const state = shallowRef<AwaitState>({ phase: 0 })
    // `current` guards against a superseded promise settling after `resolve` changed (e.g. a second
    // submit hands the same <Await> instance a new deferred) — only the latest resolve writes state.
    let current: unknown
    // `immediate` runs synchronously in setup on BOTH server and client: a non-deferred value renders
    // immediately; a deferred renders the fallback now and settles later. On the server the late
    // settle is a no-op (the sync render already produced the fallback); on the client it re-renders.
    watch(
      () => props.resolve as unknown,
      (resolve) => {
        current = resolve
        if (!isDeferred(resolve)) {
          state.value = { phase: 1, value: resolve }
          return
        }
        state.value = { phase: 0 } // reset to fallback for a freshly-supplied deferred
        resolve.promise.then(
          (value) => {
            if (current === resolve) state.value = { phase: 1, value }
          },
          (error) => {
            if (current === resolve) state.value = { phase: 2, error }
          },
        )
      },
      { immediate: true },
    )
    return (): VNode | undefined => {
      const s = state.value
      if (s.phase === 1) return slots.default?.(s.value) as VNode | undefined
      if (s.phase === 2) return slots.error?.(s.error) as VNode | undefined
      return slots.fallback?.() as VNode | undefined
    }
  },
})

/**
 * `errorBoundary` — the Vue error-boundary chain element for nifra's `_error.tsx`. Its own module
 * (imports only `vue`) so the client codegen can import it from `@nifrajs/web-vue/client` (which
 * re-exports it). No template (render function).
 */
import { type Component, defineComponent, h, onErrorCaptured, ref } from "vue"

/**
 * Build an error-boundary chain element bound to `fallback` (a route's `_error` component). nifra's
 * client codegen inserts it before the page in the matched chain; a render error in the subtree is
 * captured (`onErrorCaptured`) and renders `fallback` with `{ data: { name, message } }` instead of
 * crashing. DOM-transparent (renders the default slot directly), so it never disturbs hydration.
 */
export function errorBoundary(fallback: unknown): unknown {
  return defineComponent({
    name: "NifraErrorBoundary",
    setup(_props, { slots }) {
      const error = ref<Error | null>(null)
      onErrorCaptured((e: unknown) => {
        error.value = e instanceof Error ? e : new Error(String(e))
        return false // handled — stop propagation
      })
      return () => {
        const e = error.value
        if (e === null) return slots.default?.()
        return h(fallback as Component, { data: { name: e.name, message: e.message } })
      }
    },
  })
}

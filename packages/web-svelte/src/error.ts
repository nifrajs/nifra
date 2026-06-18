/**
 * `errorBoundary` — the Svelte `_error.tsx` boundary chain element. Svelte components are compiled (not
 * JS closures), so unlike the other adapters this can't return a component bound to `fallback`. Instead
 * it returns a **marker** that `Chain.svelte` recognises and renders as a `<svelte:boundary>` (Svelte
 * 5.3+) with `fallback` as the `failed` snippet. Re-exported from `@nifrajs/web-svelte/client` so nifra's
 * client codegen inserts it before the page in the matched chain.
 */
export interface NifraSvelteErrorBoundary {
  readonly __nifraErrorBoundary: unknown
}

/** Wrap a route's `_error` component as a boundary marker for `Chain.svelte` to render. */
export function errorBoundary(fallback: unknown): NifraSvelteErrorBoundary {
  return { __nifraErrorBoundary: fallback }
}

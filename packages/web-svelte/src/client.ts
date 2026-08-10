import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
/**
 * @nifrajs/web-svelte/client - Svelte 5 client runtime. `hydrate` hydrates a single SSR'd route via the
 * recursive `Chain`; `mountRouter` hydrates the reactive `Router` component, which subscribes to the
 * agnostic store and re-renders the matched chain on every client navigation (no full reload). Both
 * use Svelte's `hydrate` (reconcile against the SSR markup). Kept in its own entry so server code
 * stays out of the client bundle.
 */
import { hydrate as svelteHydrate } from "svelte"
import Chain from "./Chain.svelte"
import { setMountedRouter } from "./fetcher.ts"
import Router from "./Router.svelte"

// The `_error` boundary marker - Chain.svelte renders it as a <svelte:boundary>. Re-exported here so
// nifra's client codegen resolves it from `@nifrajs/web-svelte/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

/** Hydrate a server-rendered Svelte layout `chain` (with the loader `props`) inside `container`. */
export interface HydrationAssuranceOptions {
  readonly onWarning?: (message: string) => void
}

function assuranceWarning(): ((message: string) => void) | undefined {
  const value = (globalThis as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("nifra.hydration.assurance")
  ]
  if (typeof value !== "object" || value === null) return undefined
  const callback = (value as { onWarning?: unknown }).onWarning
  return typeof callback === "function" ? (callback as (message: string) => void) : undefined
}

export function hydrate(
  chain: readonly unknown[],
  props: RenderProps,
  container: unknown,
  options?: HydrationAssuranceOptions,
): void {
  const warning = options?.onWarning ?? assuranceWarning()
  const originalWarn = console.warn
  if (warning !== undefined) console.warn = (...args) => warning(args.map(String).join(" "))
  svelteHydrate(Chain, {
    target: container as Element,
    props: { chain, props, layoutData: props.layoutData },
  })
  if (warning !== undefined) console.warn = originalWarn
}

/** Testing hook used by verification runners to observe Svelte warnings and identity. */
export const hydrationAssuranceHook = Object.freeze({
  framework: "svelte" as const,
  runtimeIdentity: (): object => svelteHydrate,
})

/**
 * Hydrate a stateful Svelte Router. The `Router` component holds the store snapshot in `$state` and
 * re-renders the matched layout chain on each store change - so client navigations swap routes without
 * a full reload. Its initial render matches the SSR markup (the server rendered `Chain` for the same
 * matched route), so hydration reconciles cleanly.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, searchSchemas, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  const warning = assuranceWarning()
  const originalWarn = console.warn
  if (warning !== undefined) console.warn = (...args) => warning(args.map(String).join(" "))
  try {
    svelteHydrate(Router, {
      target: container as Element,
      props: { router, routes, searchSchemas },
    })
  } finally {
    if (warning !== undefined) console.warn = originalWarn
  }
}

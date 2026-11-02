import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
import { setRouteSlotRuntime } from "@nifrajs/web/client"
/**
 * @nifrajs/web-svelte/client - Svelte 5 client runtime. `hydrate` hydrates a single SSR'd route via the
 * recursive `Chain`; `mountRouter` hydrates the reactive `Router` component, which subscribes to the
 * agnostic store and re-renders the matched chain on every client navigation (no full reload). Both
 * use Svelte's `hydrate` (reconcile against the SSR markup). Kept in its own entry so server code
 * stays out of the client bundle.
 */
import { assuranceHook } from "@nifrajs/web/internal/hydration-assurance"
import { hydrate as svelteHydrate } from "svelte"
import Chain from "./Chain.svelte"
import { setMountedRouter } from "./fetcher.ts"
import Router from "./Router.svelte"
import { warningsTo } from "./warnings.ts"

// The `_error` boundary marker - Chain.svelte renders it as a <svelte:boundary>. Re-exported here so
// nifra's client codegen resolves it from `@nifrajs/web-svelte/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

/** Hydrate a server-rendered Svelte layout `chain` (with the loader `props`) inside `container`. */
export interface HydrationAssuranceOptions {
  readonly onWarning?: (message: string) => void
}

export function hydrate(
  chain: readonly unknown[],
  props: RenderProps,
  container: unknown,
  options?: HydrationAssuranceOptions,
): void {
  warningsTo(options?.onWarning ?? assuranceHook("onWarning"), () =>
    svelteHydrate(Chain, {
      target: container as Element,
      props: { chain, props, data: props.data, layoutData: props.layoutData },
    }),
  )
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
  const { router, routes, searchSchemas, matchChains, container } = options
  setRouteSlotRuntime({ router, routes, searchSchemas, matchChains })
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  warningsTo(assuranceHook("onWarning"), () =>
    svelteHydrate(Router, {
      target: container as Element,
      props: { router, routes, searchSchemas, matchChains },
    }),
  )
}

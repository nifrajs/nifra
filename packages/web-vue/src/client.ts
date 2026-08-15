import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
// `/client`, not the root: the root's graph carries the server, and Vite's dev server evaluates it
// instead of tree-shaking it - which broke hydration before the browser ran a line of app code.
import { searchOfChain } from "@nifrajs/web/client"
/**
 * @nifrajs/web-vue/client - Vue client runtime. `hydrate` hydrates a single SSR'd route; `mountRouter`
 * hydrates a stateful Router whose root component subscribes to the agnostic store (a `shallowRef`
 * fed by `router.subscribe`) and re-renders the matched chain on every client navigation (no full
 * reload). `createSSRApp(...).mount` reconciles against the SSR markup (Vue's hydration). Kept in its
 * own entry so server code stays out of the client bundle.
 */
import { type Component, createSSRApp, defineComponent, onScopeDispose, shallowRef } from "vue"
import { compose } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"

// The `_error` boundary chain element - defined in its own module, re-exported here so nifra's client
// codegen resolves it from `@nifrajs/web-vue/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

const rootFor = (render: () => unknown): Component =>
  defineComponent({ setup: () => () => render() })

function assuranceWarning(): ((message: string) => void) | undefined {
  const value = (globalThis as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("nifra.hydration.assurance")
  ]
  if (typeof value !== "object" || value === null) return undefined
  const callback = (value as { onWarning?: unknown }).onWarning
  return typeof callback === "function" ? (callback as (message: string) => void) : undefined
}

/** Hydrate a server-rendered Vue layout `chain` (with the loader `props`) inside `container`. */
export interface HydrationAssuranceOptions {
  readonly onWarning?: (message: string) => void
}

export function hydrate(
  chain: readonly unknown[],
  props: RenderProps,
  container: unknown,
  options?: HydrationAssuranceOptions,
): void {
  const warning = options?.onWarning ?? assuranceWarning()
  const app = createSSRApp(rootFor(() => compose(chain, props)))
  if (warning !== undefined) app.config.warnHandler = (message) => warning(message)
  app.mount(container as Element)
}

/** Testing hook used by verification runners to observe Vue warnings and identity. */
export const hydrationAssuranceHook = Object.freeze({
  framework: "vue" as const,
  runtimeIdentity: (): object => createSSRApp,
})

/**
 * Hydrate a stateful Vue Router. A `shallowRef` holds the store snapshot; `router.subscribe` writes
 * each new snapshot into it, so the root re-renders the matched layout chain on every store change -
 * client navigations swap routes without a full reload. The initial snapshot matches the SSR markup.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, searchSchemas, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  const Root = defineComponent({
    setup() {
      const state = shallowRef(router.snapshot())
      const unsubscribe = router.subscribe(() => {
        state.value = router.snapshot()
      })
      onScopeDispose(unsubscribe)
      return () => {
        const s = state.value
        // This route's typed `search` from the URL + schema chain (the SAME `searchOfChain` the server
        // ran), recomputed each render so `useSearch` stays reactive and hydrates with no drift.
        const q = s.path.indexOf("?")
        const rawSearch = q === -1 ? "" : s.path.slice(q)
        return compose(routes[s.routeId] ?? [], {
          data: s.data,
          actionData: s.actionData,
          pending: s.pending,
          search: searchOfChain(searchSchemas?.[s.routeId] ?? [], rawSearch),
          ...(s.submission ? { submission: s.submission } : {}),
          ...(s.boundaries !== undefined ? { boundaries: s.boundaries } : {}),
        })
      }
    },
  })
  const app = createSSRApp(Root)
  const warning = assuranceWarning()
  if (warning !== undefined) app.config.warnHandler = (message) => warning(message)
  app.mount(container as Element)
}

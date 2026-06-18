import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
/**
 * @nifrajs/web-vue/client — Vue client runtime. `hydrate` hydrates a single SSR'd route; `mountRouter`
 * hydrates a stateful Router whose root component subscribes to the agnostic store (a `shallowRef`
 * fed by `router.subscribe`) and re-renders the matched chain on every client navigation (no full
 * reload). `createSSRApp(...).mount` reconciles against the SSR markup (Vue's hydration). Kept in its
 * own entry so server code stays out of the client bundle.
 */
import { type Component, createSSRApp, defineComponent, onScopeDispose, shallowRef } from "vue"
import { compose } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"

// The `_error` boundary chain element — defined in its own module, re-exported here so nifra's client
// codegen resolves it from `@nifrajs/web-vue/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

const rootFor = (render: () => unknown): Component =>
  defineComponent({ setup: () => () => render() })

/** Hydrate a server-rendered Vue layout `chain` (with the loader `props`) inside `container`. */
export function hydrate(chain: readonly unknown[], props: RenderProps, container: unknown): void {
  createSSRApp(rootFor(() => compose(chain, props))).mount(container as Element)
}

/**
 * Hydrate a stateful Vue Router. A `shallowRef` holds the store snapshot; `router.subscribe` writes
 * each new snapshot into it, so the root re-renders the matched layout chain on every store change —
 * client navigations swap routes without a full reload. The initial snapshot matches the SSR markup.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, container } = options
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
        return compose(routes[s.routeId] ?? [], {
          data: s.data,
          actionData: s.actionData,
          pending: s.pending,
          ...(s.submission ? { submission: s.submission } : {}),
        })
      }
    },
  })
  createSSRApp(Root).mount(container as Element)
}

import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
/**
 * @nifrajs/web-vue/client - Vue client runtime. `hydrate` hydrates a single SSR'd route; `mountRouter`
 * hydrates a stateful Router whose root component subscribes to the agnostic store (a `shallowRef`
 * fed by `router.subscribe`) and re-renders the matched chain on every client navigation (no full
 * reload). `createSSRApp(...).mount` reconciles against the SSR markup (Vue's hydration). Kept in its
 * own entry so server code stays out of the client bundle.
 */
import {
  type Component,
  computed,
  createSSRApp,
  defineComponent,
  h,
  type InjectionKey,
  inject,
  onScopeDispose,
  provide,
  type Ref,
  shallowRef,
} from "vue"
import { compose, pageNode } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"
import { RouteContextProvider } from "./route-context.ts"
import { routeProps } from "./route-props.ts"

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

type View = { readonly chain: readonly unknown[]; readonly props: RenderProps }
const VIEW_KEY: InjectionKey<Readonly<Ref<View>>> = Symbol("nifra.web-vue.view")

// One level of the chain as `compose` builds it. A layout gets the next level as a STABLE slot, so Vue
// re-renders it only when its own props change, and the level inside follows the view on its own: a
// reload that kept the data (the router shares what it did not change) re-renders a layout or the page
// only for a prop of its own that moved, such as the page's `pending`.
const Level = defineComponent({
  name: "NifraLevel",
  props: { depth: { type: Number, required: true } },
  setup(props) {
    const view = inject(VIEW_KEY)
    return () => {
      const { chain, props: route } = view?.value ?? { chain: [], props: { data: null } }
      const component = chain[props.depth]
      if (component === undefined) return null
      if (props.depth === chain.length - 1) return pageNode(component, route)
      const data = route.layoutData?.[props.depth] ?? null
      return h(
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry above the page is a layout module's default export, a layout component
        component as Component,
        route.boundaries === undefined ? { data } : { data, boundaries: route.boundaries },
        { default: () => h(Level, { depth: props.depth + 1 }), $stable: true },
      )
    }
  },
})

/**
 * Hydrate a stateful Vue Router. A `shallowRef` holds the store snapshot; `router.subscribe` writes
 * each new snapshot into it, so the root re-renders the matched layout chain on every store change -
 * client navigations swap routes without a full reload. The initial snapshot matches the SSR markup.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, searchSchemas, matchChains, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  const Root = defineComponent({
    setup() {
      const state = shallowRef(router.snapshot())
      const unsubscribe = router.subscribe(() => {
        state.value = router.snapshot()
      })
      onScopeDispose(unsubscribe)
      const view = computed(
        (): View => ({
          chain: routes[state.value.routeId] ?? [],
          props: routeProps(state.value, searchSchemas, matchChains),
        }),
      )
      provide(VIEW_KEY, view)
      // The same host markup `compose` renders, so it hydrates the server's chain as it is.
      return () =>
        h(
          RouteContextProvider,
          { value: view.value.props },
          { default: () => h(Level, { depth: 0 }) },
        )
    },
  })
  const app = createSSRApp(Root)
  const warning = assuranceWarning()
  if (warning !== undefined) app.config.warnHandler = (message) => warning(message)
  app.mount(container as Element)
}

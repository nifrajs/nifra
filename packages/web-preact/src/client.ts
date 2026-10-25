import type { BoundaryStates, MountRouterOptions, RenderProps } from "@nifrajs/web"
import { routeProps } from "@nifrajs/web/internal/route-props-runtime"
/**
 * @nifrajs/web-preact/client - Preact client runtime. `hydrate` hydrates a single SSR'd route;
 * `mountRouter` hydrates a stateful Router that subscribes to the agnostic store (via
 * `useSyncExternalStore` from preact/compat) and re-renders the matched chain on every client
 * navigation (no full reload). Kept in its own entry so server code (preact-render-to-string) stays
 * out of the client bundle.
 */
import {
  type ComponentChildren,
  createContext,
  type FunctionComponent,
  h,
  hydrate as preactHydrate,
  type VNode,
} from "preact"
import { memo, useSyncExternalStore } from "preact/compat"
import { useContext } from "preact/hooks"
import { compose, withRouteContext } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"

// The `_error` boundary chain element - defined in its own (DOM-free) module, re-exported here so
// nifra's client codegen resolves it from `@nifrajs/web-preact/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

/**
 * Preact cannot apply Bun's hot updates, so the generated client entry reloads instead.
 *
 * Bun's dev server runs React Fast Refresh over JSX modules. A Preact component compiles to JSX that
 * looks the same, so the update is ACCEPTED - and then dropped, because Preact's refresh runtime
 * (prefresh) is not the one Bun installs. Measured: `bun:beforeUpdate` and `bun:afterUpdate` both fire,
 * the server logs the rebuild, the browser keeps rendering the old component and never reloads. The
 * edit simply appears not to happen.
 *
 * Reloading loses component state, which React keeps here. That is the honest trade until Bun's dev
 * server can install prefresh: a visible reload beats an edit that silently does nothing.
 */
export const hotUpdateNeedsReload = true

/** Hydrate a server-rendered Preact layout `chain` (with the loader `props`) inside `container`. */
export function hydrate(chain: readonly unknown[], props: RenderProps, container: unknown): void {
  preactHydrate(compose(chain, props), container as Element)
}

/** The chain the mounted router renders, and the props it renders it with. */
const ChainContext = createContext<{
  readonly chain: readonly unknown[]
  readonly props: RenderProps
}>({ chain: [], props: { data: null } })
type LayoutProps = {
  readonly data: unknown
  readonly boundaries?: BoundaryStates | undefined
  readonly children?: ComponentChildren
}
// One `memo` per component, so its type stays the same across renders.
const memoized = <P extends object>(): ((
  component: FunctionComponent<P>,
) => FunctionComponent<P>) => {
  const held = new WeakMap<FunctionComponent<P>, FunctionComponent<P>>()
  return (component) => {
    let memoComponent = held.get(component)
    if (memoComponent === undefined) {
      memoComponent = memo(component)
      held.set(component, memoComponent)
    }
    return memoComponent
  }
}
const memoPage = memoized<RenderProps>()
const memoLayout = memoized<LayoutProps>()
// One element per depth, created once: a layout's `children` stays the same element across renders,
// so its memo compares equal, while the level inside still re-renders through the context.
const levels: VNode<{ readonly depth: number }>[] = []
const levelAt = (depth: number): VNode<{ readonly depth: number }> => {
  let level = levels[depth]
  if (level === undefined) {
    level = h(Level, { depth })
    levels[depth] = level
  }
  return level
}
// One level of the chain as `compose` builds it, memoized on its own props: a reload that kept the data
// (the router shares what it did not change) re-renders a layout or the page only for a prop of its own
// that moved, such as the page's `pending`.
function Level({ depth, ...overrides }: { readonly depth: number }): ComponentChildren {
  const { chain, props } = useContext(ChainContext)
  // A class component (an `_error` boundary) renders through the memo's wrapper all the same.
  if (depth === chain.length - 1)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain holds the route's modules' default exports, its last entry the page component
    return h(memoPage(chain[depth] as FunctionComponent<RenderProps>), {
      ...props,
      ...overrides,
    })
  return h(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry above the page is a layout module's default export, a layout component
    memoLayout(chain[depth] as FunctionComponent<LayoutProps>),
    // Layouts may clone their child with extra props, including `children`, just as in SSR compose.
    {
      data: props.layoutData?.[depth] ?? null,
      boundaries: props.boundaries,
      children: levelAt(depth + 1),
      ...overrides,
    },
  )
}

/**
 * Hydrate a stateful Preact Router. `useSyncExternalStore` (preact/compat) subscribes to the
 * agnostic store and re-renders the matched layout chain on each store change - so client
 * navigations swap routes without a full reload. Preact's compat `useSyncExternalStore` is 2-arg
 * (no `getServerSnapshot`); `router.snapshot` is deterministic, so hydration matches the SSR markup.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, searchSchemas, matchChains, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot)
    const props = routeProps(state, searchSchemas, matchChains)
    // The same host markup `compose` renders, so it hydrates the server's chain as it is.
    return withRouteContext(
      props,
      h(
        ChainContext.Provider,
        { value: { chain: routes[state.routeId] ?? [], props } },
        levelAt(0),
      ),
    )
  }
  preactHydrate(h(Router, null), container as Element)
}

import type { BoundaryStates, MountRouterOptions, RenderProps } from "@nifrajs/web"
/**
 * @nifrajs/web-react/client - React client runtime. `hydrate` hydrates a single SSR'd route;
 * `mountRouter` hydrates a stateful Router that subscribes to the agnostic store (via
 * `useSyncExternalStore`) and re-renders the matched chain on every client navigation (no full
 * reload). Kept in its own entry so server code stays out of the client bundle.
 */
import * as React from "react"
import {
  type ComponentType,
  createContext,
  createElement,
  type FunctionComponent,
  memo,
  type ReactElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react"
import { hydrateRoot } from "react-dom/client"
import { compose, withRouterContext } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"
import { routeProps } from "./route-props.ts"

// The `_error` boundary chain element - defined in its own (react-dom-free) module, re-exported here so
// nifra's client codegen resolves it from `@nifrajs/web-react/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

/** Hydrate a server-rendered React layout `chain` (with the loader `props`) inside `container`. */
export interface HydrationAssuranceOptions {
  readonly onRecoverableError?: (error: unknown, info?: unknown) => void
}

function assuranceError(): HydrationAssuranceOptions["onRecoverableError"] {
  const value = (globalThis as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("nifra.hydration.assurance")
  ]
  if (typeof value !== "object" || value === null) return undefined
  const callback = (value as { onRecoverableError?: unknown }).onRecoverableError
  return typeof callback === "function"
    ? (callback as HydrationAssuranceOptions["onRecoverableError"])
    : undefined
}

export function hydrate(
  chain: readonly unknown[],
  props: RenderProps,
  container: unknown,
  options?: HydrationAssuranceOptions,
): void {
  const onRecoverableError = options?.onRecoverableError ?? assuranceError()
  if (onRecoverableError === undefined) hydrateRoot(container as Element, compose(chain, props))
  else hydrateRoot(container as Element, compose(chain, props), { onRecoverableError })
}

/** Testing hook used by verification runners to observe React's recoverable errors and identity. */
export const hydrationAssuranceHook = Object.freeze({
  framework: "react" as const,
  runtimeIdentity: (): object => React,
})

/** The chain the mounted router renders, and the props it renders it with. */
const ChainContext = createContext<{
  readonly chain: readonly unknown[]
  readonly props: RenderProps
}>({ chain: [], props: { data: null } })
type LayoutProps = {
  readonly data: unknown
  readonly boundaries?: BoundaryStates | undefined
  readonly children?: ReactNode
}
// One `memo` per component, so its type stays the same across renders.
const memoized = <P extends object>(): ((component: ComponentType<P>) => ComponentType<P>) => {
  const held = new WeakMap<ComponentType<P>, ComponentType<P>>()
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
const levels: ReactElement[] = []
const levelAt = (depth: number): ReactElement => {
  levels[depth] ??= createElement(Level, { depth })
  return levels[depth]
}
// One level of the chain as `compose` builds it, memoized on its own props: a reload that kept the data
// (the router shares what it did not change) re-renders a layout or the page only for a prop of its own
// that moved, such as the page's `pending`.
function Level({ depth, ...overrides }: { readonly depth: number }): ReactNode {
  const { chain, props } = useContext(ChainContext)
  if (depth === chain.length - 1)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain holds the route's modules' default exports, its last entry the page component
    return createElement(memoPage(chain[depth] as ComponentType<RenderProps>), {
      ...props,
      ...overrides,
    })
  return createElement(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry above the page is a layout module's default export, a layout component
    memoLayout(chain[depth] as ComponentType<LayoutProps>),
    // Layouts may clone their child with extra props, including `children`, just as in SSR compose.
    {
      data: props.layoutData?.[depth] ?? null,
      boundaries: props.boundaries,
      // biome-ignore lint/correctness/noChildrenProp: cloneElement overrides must be able to replace the default child, including with undefined
      children: levelAt(depth + 1),
      ...overrides,
    },
  )
}

/**
 * Hydrate a stateful React Router. `useSyncExternalStore` subscribes to the agnostic store and
 * re-renders the matched layout chain on each store change - so client navigations swap routes
 * without a full reload. `getServerSnapshot` (3rd arg) returns the initial state, matching the
 * SSR markup on hydration.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, searchSchemas, matchChains, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  // What the server rendered. React hydrates against THIS, whatever the store says by the time it gets
  // to the component - hydration is scheduled, and a store that moved on first (a client loader that
  // answered, a held `ssr = false` page released) would otherwise hydrate a tree the markup never had.
  // React then re-renders with the live snapshot on its own.
  const hydrated = router.snapshot()
  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot, () => hydrated)
    const props = routeProps(state, searchSchemas, matchChains)
    // The same host markup `compose` renders, so it hydrates the server's chain as it is.
    return withRouterContext(
      props,
      createElement(
        ChainContext.Provider,
        { value: { chain: routes[state.routeId] ?? [], props } },
        levelAt(0),
      ),
    )
  }
  const onRecoverableError = assuranceError()
  hydrateRoot(
    container as Element,
    createElement(Router),
    ...(onRecoverableError === undefined ? [] : [{ onRecoverableError }]),
  )
}

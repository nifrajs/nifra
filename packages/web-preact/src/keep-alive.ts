/**
 * @nifrajs/web-preact/keep-alive - the client mount of an app with a `keepAlive` route, which the
 * generated client entry imports in place of `@nifrajs/web-preact/client` (whose exports it carries).
 *
 * It renders the page on screen and every page the router keeps, grouped by the layouts they share
 * (`slotTree`), each kept page inside the two slot wrappers; the DOM half takes a hidden one out of the
 * document. A hidden page keeps running: `usePageVisibility`, `onPageHide` and `onPageShow` (from
 * `@nifrajs/web-preact/router`) let it pause. Everything a page reads from the router comes from its
 * own slot's state, so a hidden page never sees another page's params.
 */
import type { MountRouterOptions, RenderProps, RouterState } from "@nifrajs/web"
import {
  additionsFor,
  type KeptMount,
  keptMount,
  propsByState,
  SLOT_ROOT,
  type SlotAdditions,
  slotChildren,
} from "@nifrajs/web/internal/keep-alive-mount"
import { routeProps } from "@nifrajs/web/internal/route-props-runtime"
import type { KeepAliveRouter, KeepAliveTable, SlotNode } from "@nifrajs/web/keep-alive"
import {
  type ComponentChildren,
  createContext,
  type FunctionComponent,
  h,
  hydrate as preactHydrate,
  type VNode,
} from "preact"
import { memo, useSyncExternalStore } from "preact/compat"
import { useContext, useLayoutEffect, useMemo, useRef } from "preact/hooks"
import { withRouteContext } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"
import {
  type PageCallbacks,
  pageCallbacksContext,
  pageVisibilityContext,
} from "./page-visibility.ts"
import { inSlot } from "./slot.ts"

export * from "./client.ts"
export { onPageHide, onPageShow, usePageVisibility } from "./page-visibility.ts"

/** `mountRouter`'s options in a keep-alive app: the generated entry adds where the wrappers go. */
export interface KeepAliveMountOptions extends MountRouterOptions {
  readonly router: KeepAliveRouter
  readonly keepAlive: KeepAliveTable
}

type LayoutProps = {
  readonly data: unknown
  readonly boundaries?: RenderProps["boundaries"] | undefined
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

// What a slot renders with. One value per mount: a slot reads nothing that changes per render from
// context, or a context change would re-render every hidden page past its memo.
interface Mount extends KeptMount {
  readonly propsOf: (state: RouterState) => RenderProps
}
const MountContext = createContext<Mount | undefined>(undefined)
// Parent key → the slots under it, for the current render.
const NodesContext = createContext<ReadonlyMap<string, readonly SlotNode[]>>(new Map())

// The slots under one parent, read from the view: a layout's `children` is one element per parent,
// created once, so the layout's memo compares equal while the slots under it still update.
function Slots({ parent, ...rest }: { readonly parent: string }): ComponentChildren {
  const nodes = useContext(NodesContext).get(parent) ?? []
  const added = additionsFor(
    useRef(new Map<string, SlotAdditions>()).current,
    nodes,
    Object.keys(rest).length === 0 ? undefined : rest,
  )
  return nodes.map((node) => h(Slot, { key: node.key, node, added: added(node) }))
}
const slotsElements = new Map<string, VNode<{ readonly parent: string }>>()
const slotsOf = (parent: string): VNode<{ readonly parent: string }> => {
  let element = slotsElements.get(parent)
  if (element === undefined) {
    element = h(Slots, { parent })
    slotsElements.set(parent, element)
  }
  return element
}

// The page's own chain from `depth` on: an `_error` boundary, then the page. `added` goes to the first.
const pageChain = (
  chain: readonly unknown[],
  depth: number,
  props: RenderProps,
  added?: SlotAdditions,
): ComponentChildren => {
  if (depth >= chain.length - 1)
    return h(
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain holds the route's modules' default exports, its last entry the page component
      memoPage(chain[chain.length - 1] as FunctionComponent<RenderProps>),
      added === undefined ? props : { ...props, ...added },
    )
  return h(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an entry between the layouts and the page is the `_error` boundary component
    memoLayout(chain[depth] as FunctionComponent<LayoutProps>),
    { data: props.layoutData?.[depth] ?? null, boundaries: props.boundaries, ...added },
    pageChain(chain, depth + 1, props),
  )
}

// One node, memoized on its identity: the tree keeps a node that did not change, so a hidden page
// never renders while it is hidden.
const Slot = memo(function Slot({
  node,
  added,
}: {
  readonly node: SlotNode
  readonly added: SlotAdditions
}): ComponentChildren {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every slot renders under the mount's provider
  const view = useContext(MountContext) as Mount
  const callbacks = useMemo<PageCallbacks>(() => ({ hide: new Set(), show: new Set() }), [])
  const wasHidden = useRef(node.hidden)
  // A slot's layout effect runs before the mount's, which parks the page: a page's `onPageHide` runs
  // while it is still in the document.
  useLayoutEffect(() => {
    if (wasHidden.current === node.hidden) return
    wasHidden.current = node.hidden
    for (const callback of [...(node.hidden ? callbacks.hide : callbacks.show)]) callback()
  }, [node.hidden])
  const props = view.propsOf(node.state)
  const chain = view.chainOf(node.state)
  const content =
    node.children === undefined
      ? pageChain(chain, node.depth, props, added)
      : h(
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry above the page is a layout module's default export, a layout component
          memoLayout(chain[node.depth] as FunctionComponent<LayoutProps>),
          { data: props.layoutData?.[node.depth] ?? null, boundaries: props.boundaries, ...added },
          slotsOf(node.key),
        )
  if (!node.wrapped) return content
  return inSlot(
    h(
      pageCallbacksContext().Provider,
      { value: callbacks },
      h(
        pageVisibilityContext().Provider,
        { value: !node.hidden },
        withRouteContext(props, content),
      ),
    ),
    view.entry(node.key),
    view.page(node.key),
  )
})

/**
 * Hydrate the keep-alive view. Like `mountRouter` from `@nifrajs/web-preact/client`, it hydrates
 * against the state the server rendered and then follows the store.
 */
export function mountRouter(options: KeepAliveMountOptions): void {
  const { router, searchSchemas, container } = options
  const matchChains = options.matchChains ?? {}
  setMountedRouter(router)
  const mount: Mount = {
    ...keptMount(options),
    propsOf: propsByState((state) => routeProps(state, searchSchemas, matchChains)),
  }

  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot)
    const previous = useRef<readonly SlotNode[] | undefined>(undefined)
    const tree = useMemo(() => mount.tree(state, previous.current), [state])
    previous.current = tree
    const nodes = useMemo(() => slotChildren(tree), [tree])
    // After every slot below has committed: park what this render hid, restore what it showed again.
    useLayoutEffect(() => mount.after(tree), [tree])
    return withRouteContext(
      mount.propsOf(state),
      h(
        MountContext.Provider,
        { value: mount },
        h(NodesContext.Provider, { value: nodes }, slotsOf(SLOT_ROOT)),
      ),
    )
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the generated entry passes the element the server rendered the app into
  preactHydrate(h(Router, null), container as Element)
}

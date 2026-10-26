/**
 * @nifrajs/web-react/keep-alive - the client mount of an app with a `keepAlive` route, which the
 * generated client entry imports in place of `@nifrajs/web-react/client` (whose exports it carries).
 *
 * It renders the page on screen and every page the router keeps, grouped by the layouts they share
 * (`slotTree`), each kept page inside the two slot wrappers with `<Activity>` between them: a hidden
 * page's effects clean up while its state stays, and the DOM half takes it out of the document.
 * Everything a page reads from the router comes from its own slot's state, so a hidden page never sees
 * another page's params.
 */
import type { MountRouterOptions, RenderProps, RouterState } from "@nifrajs/web"
import { assuranceHook } from "@nifrajs/web/internal/hydration-assurance"
import {
  additionsFor,
  type KeptMount,
  keptMount,
  propsByState,
  SLOT_ROOT,
  type SlotAdditions,
  slotChildren,
} from "@nifrajs/web/internal/keep-alive-mount"
import type { KeepAliveRouter, KeepAliveTable, SlotNode } from "@nifrajs/web/keep-alive"
import {
  type ComponentType,
  createContext,
  createElement,
  type FunctionComponent,
  memo,
  type ReactElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"
import { hydrateRoot } from "react-dom/client"
import { withRouterContext } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"
import { type LayoutProps, memoLayout, memoPage } from "./memo-chain.ts"
import { pageVisibilityContext } from "./page-visibility.ts"
import { routeProps } from "./route-props.ts"
import { inSlot } from "./slot.ts"

export * from "./client.ts"

/** `mountRouter`'s options in a keep-alive app: the generated entry adds where the wrappers go. */
export interface KeepAliveMountOptions extends MountRouterOptions {
  readonly router: KeepAliveRouter
  readonly keepAlive: KeepAliveTable
}

export { usePageVisibility } from "./page-visibility.ts"

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
function Slots({ parent, ...rest }: { readonly parent: string }): ReactNode {
  const nodes = useContext(NodesContext).get(parent) ?? []
  const added = additionsFor(
    useRef(new Map<string, SlotAdditions>()).current,
    nodes,
    Object.keys(rest).length === 0 ? undefined : rest,
  )
  // One slot renders as a lone child, not an array: an array forks the tree `useId` reads, and the
  // server's single chain has no fork, so ids would no longer hydrate. Keys keep the fiber either way.
  const [only] = nodes
  if (nodes.length === 1 && only !== undefined)
    return createElement(Slot, { key: only.key, node: only, added: added(only) })
  return nodes.map((node) => createElement(Slot, { key: node.key, node, added: added(node) }))
}
const slotsElements = new Map<string, ReactElement>()
const slotsOf = (parent: string): ReactElement => {
  let element = slotsElements.get(parent)
  if (element === undefined) {
    element = createElement(Slots, { parent })
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
): ReactNode => {
  if (depth >= chain.length - 1)
    return createElement(
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain holds the route's modules' default exports, its last entry the page component
      memoPage(chain[chain.length - 1] as ComponentType<RenderProps>),
      added === undefined ? props : { ...props, ...added },
    )
  return createElement(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an entry between the layouts and the page is the `_error` boundary component
    memoLayout(chain[depth] as ComponentType<LayoutProps>),
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
}): ReactNode {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every slot renders under the mount's provider
  const view = useContext(MountContext) as Mount
  const props = view.propsOf(node.state)
  const chain = view.chainOf(node.state)
  const content =
    node.children === undefined
      ? pageChain(chain, node.depth, props, added)
      : createElement(
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry above the page is a layout module's default export, a layout component
          memoLayout(chain[node.depth] as ComponentType<LayoutProps>),
          { data: props.layoutData?.[node.depth] ?? null, boundaries: props.boundaries, ...added },
          slotsOf(node.key),
        )
  if (!node.wrapped) return content
  return inSlot(
    node.hidden,
    createElement(
      pageVisibilityContext().Provider,
      { value: !node.hidden },
      withRouterContext(props, content),
    ),
    view.entry(node.key),
    view.page(node.key),
  )
})

/**
 * Hydrate the keep-alive view. Like `mountRouter` from `@nifrajs/web-react/client`, it hydrates
 * against the state the server rendered and then follows the store.
 */
export function mountRouter(options: KeepAliveMountOptions): void {
  const { router, searchSchemas, container } = options
  const matchChains = options.matchChains ?? {}
  setMountedRouter(router)
  const hydrated = router.snapshot()
  const mount: Mount = {
    ...keptMount(options),
    propsOf: propsByState((state) => routeProps(state, searchSchemas, matchChains)),
  }

  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot, () => hydrated)
    const previous = useRef<readonly SlotNode[] | undefined>(undefined)
    const tree = useMemo(() => mount.tree(state, previous.current), [state])
    previous.current = tree
    const nodes = useMemo(() => slotChildren(tree), [tree])
    // After every slot below has committed: park what this render hid, restore what it showed again.
    useLayoutEffect(() => {
      mount.after(tree)
    }, [tree])
    return withRouterContext(
      mount.propsOf(state),
      createElement(
        MountContext.Provider,
        { value: mount },
        createElement(NodesContext.Provider, { value: nodes }, slotsOf(SLOT_ROOT)),
      ),
    )
  }
  const onRecoverableError = assuranceHook("onRecoverableError")
  hydrateRoot(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the generated entry passes the element the server rendered the app into
    container as Element,
    createElement(Router),
    ...(onRecoverableError === undefined ? [] : [{ onRecoverableError }]),
  )
}

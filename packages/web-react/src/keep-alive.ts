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
import {
  createSlotParking,
  type KeepAliveRouter,
  type KeepAliveTable,
  type SlotNode,
  slotTree,
} from "@nifrajs/web/keep-alive"
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
import { routeProps } from "./route-props.ts"
import { inSlot } from "./slot.ts"

export * from "./client.ts"

/** `mountRouter`'s options in a keep-alive app: the generated entry adds where the wrappers go. */
export interface KeepAliveMountOptions extends MountRouterOptions {
  readonly keepAlive: KeepAliveTable
}

const VisibleContext = createContext(true)

/**
 * Whether the page this component renders in is on screen. `false` while it is kept hidden behind
 * another page; its effects have cleaned up by then (`Activity`), and run again when it is shown.
 */
export function usePageVisibility(): boolean {
  return useContext(VisibleContext)
}

type LayoutProps = {
  readonly data: unknown
  readonly boundaries?: RenderProps["boundaries"] | undefined
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

const ROOT = "\0root"

// What a slot renders with. One value per mount: a slot reads nothing that changes per render from
// context, or a context change would re-render every hidden page past its memo.
interface Mount {
  readonly chainOf: (state: RouterState) => readonly unknown[]
  readonly propsOf: (state: RouterState) => RenderProps
  readonly entryRef: (key: string) => (element: HTMLDivElement | null) => void
  readonly pageRef: (key: string) => (element: HTMLDivElement | null) => void
}
const MountContext = createContext<Mount | undefined>(undefined)
// Parent key → the slots under it, for the current render.
const NodesContext = createContext<ReadonlyMap<string, readonly SlotNode[]>>(new Map())

const childrenOf = (tree: readonly SlotNode[]): Map<string, readonly SlotNode[]> => {
  const nodes = new Map<string, readonly SlotNode[]>([[ROOT, tree]])
  const visit = (list: readonly SlotNode[]): void => {
    for (const node of list) {
      if (node.children === undefined) continue
      nodes.set(node.key, node.children)
      visit(node.children)
    }
  }
  visit(tree)
  return nodes
}

// The slots under one parent, read from the view: a layout's `children` is one element per parent,
// created once, so the layout's memo compares equal while the slots under it still update.
function Slots({ parent }: { readonly parent: string }): ReactNode {
  const nodes = useContext(NodesContext).get(parent) ?? []
  // One slot renders as a lone child, not an array: an array forks the tree `useId` reads, and the
  // server's single chain has no fork, so ids would no longer hydrate. Keys keep the fiber either way.
  const [only] = nodes
  if (nodes.length === 1 && only !== undefined)
    return createElement(Slot, { key: only.key, node: only })
  return nodes.map((node) => createElement(Slot, { key: node.key, node }))
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

// The page's own chain from `depth` on: an `_error` boundary, then the page.
const pageChain = (chain: readonly unknown[], depth: number, props: RenderProps): ReactNode => {
  if (depth >= chain.length - 1)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain holds the route's modules' default exports, its last entry the page component
    return createElement(memoPage(chain[chain.length - 1] as ComponentType<RenderProps>), props)
  return createElement(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an entry between the layouts and the page is the `_error` boundary component
    memoLayout(chain[depth] as ComponentType<LayoutProps>),
    { data: props.layoutData?.[depth] ?? null, boundaries: props.boundaries },
    pageChain(chain, depth + 1, props),
  )
}

// One node, memoized on its identity: the tree keeps a node that did not change, so a hidden page
// never renders while it is hidden.
const Slot = memo(function Slot({ node }: { readonly node: SlotNode }): ReactNode {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every slot renders under the mount's provider
  const view = useContext(MountContext) as Mount
  const props = view.propsOf(node.state)
  const chain = view.chainOf(node.state)
  const content =
    node.children === undefined
      ? pageChain(chain, node.depth, props)
      : createElement(
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry above the page is a layout module's default export, a layout component
          memoLayout(chain[node.depth] as ComponentType<LayoutProps>),
          { data: props.layoutData?.[node.depth] ?? null, boundaries: props.boundaries },
          slotsOf(node.key),
        )
  if (!node.wrapped) return content
  return inSlot(
    node.hidden,
    createElement(
      VisibleContext.Provider,
      { value: !node.hidden },
      withRouterContext(props, content),
    ),
    view.entryRef(node.key),
    view.pageRef(node.key),
  )
})

/**
 * Hydrate the keep-alive view. Like `mountRouter` from `@nifrajs/web-react/client`, it hydrates
 * against the state the server rendered and then follows the store.
 */
export function mountRouter(options: KeepAliveMountOptions): void {
  const { router, routes, searchSchemas, container, keepAlive: table } = options
  const matchChains = options.matchChains ?? {}
  setMountedRouter(router)
  const hydrated = router.snapshot()
  const parking = createSlotParking()
  let committed: readonly SlotNode[] | undefined
  const keep = router as Partial<KeepAliveRouter>
  keep.beforePublish?.((next) => parking.before(slotTree(next, matchChains, table, committed)))

  const props = new WeakMap<RouterState, RenderProps>()
  const propsOf = (state: RouterState): RenderProps => {
    let held = props.get(state)
    if (held === undefined) {
      held = routeProps(state, searchSchemas, matchChains)
      props.set(state, held)
    }
    return held
  }
  const mount: Mount = {
    chainOf: (state) => routes[state.routeId] ?? [],
    propsOf,
    entryRef: parking.entry,
    pageRef: parking.page,
  }

  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot, () => hydrated)
    const previous = useRef<readonly SlotNode[] | undefined>(undefined)
    const tree = useMemo(() => slotTree(state, matchChains, table, previous.current), [state])
    previous.current = tree
    const nodes = useMemo(() => childrenOf(tree), [tree])
    // After every slot below has committed: park what this render hid, restore what it showed again.
    useLayoutEffect(() => {
      committed = tree
      parking.after(tree)
    }, [tree])
    return withRouterContext(
      propsOf(state),
      createElement(
        MountContext.Provider,
        { value: mount },
        createElement(NodesContext.Provider, { value: nodes }, slotsOf(ROOT)),
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

function assuranceError(): ((error: unknown, info?: unknown) => void) | undefined {
  const value = Reflect.get(globalThis, Symbol.for("nifra.hydration.assurance"))
  if (typeof value !== "object" || value === null) return undefined
  const callback: unknown = Reflect.get(value, "onRecoverableError")
  return typeof callback === "function"
    ? (callback as (error: unknown, info?: unknown) => void)
    : undefined
}

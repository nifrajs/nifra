/**
 * The view of an app with a `keepAlive` route: the page on screen and every kept page as a tree of
 * slots (`slotTree` from `@nifrajs/web/keep-alive`), grouped by the layouts they share. The server
 * renders it with the one page a document shows and the browser hydrates it, so both sides create the
 * same components in the same order and Solid's hydration keys line up.
 *
 * A slot is keyed by its node's key, not the node object: a node is replaced whenever its state or its
 * visibility changes, and keying on it would remount the page. A slot reads its node through a memo,
 * so a hidden page, whose node the tree keeps, updates nothing while it is hidden.
 */
import type { RenderProps, RouterState } from "@nifrajs/web"
import type { SlotNode } from "@nifrajs/web/keep-alive"
import {
  type Accessor,
  type Component,
  createComponent,
  createComputed,
  createMemo,
  For,
  type JSX,
  on,
  untrack,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { PageContext, type PageSlot } from "./page-visibility.ts"
import { RenderPropsContext, SearchContext } from "./router.ts"

/** What the view renders with: one per mount, on the server or in the browser. */
export interface KeepAliveViewMount {
  /** The props of a state, as getters over it. */
  readonly propsOf: (state: Accessor<RouterState>) => RenderProps
  readonly chainOf: (state: RouterState) => readonly unknown[]
  readonly entry: (key: string) => ((element: Element) => void) | undefined
  readonly page: (key: string) => ((element: Element) => void) | undefined
}

export interface KeepAliveViewProps {
  readonly tree: Accessor<readonly SlotNode[]>
  /** The props of the state on screen, which the layouts every page shares render with. */
  readonly shown: RenderProps
  readonly mount: KeepAliveViewMount
}

type LayoutProps = {
  readonly data: unknown
  readonly boundaries?: RenderProps["boundaries"] | undefined
  readonly children?: JSX.Element
}

const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})
const CONTENTS = "display:contents"

// The providers `compose` puts around a chain, for one slot's props.
const withRouteContext = (props: RenderProps, children: () => JSX.Element): JSX.Element =>
  createComponent(SearchContext.Provider, {
    value: () => props.search ?? EMPTY_SEARCH,
    get children() {
      return createComponent(RenderPropsContext.Provider, {
        value: props,
        get children() {
          return children()
        },
      })
    },
  })

// The page's own chain from `depth` on: an `_error` boundary, then the page.
const pageChain = (chain: readonly unknown[], depth: number, props: RenderProps): JSX.Element => {
  if (depth >= chain.length - 1)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain holds the route's modules' default exports, its last entry the page component
    return createComponent(chain[chain.length - 1] as Component<RenderProps>, props)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an entry between the layouts and the page is the `_error` boundary component
  return createComponent(chain[depth] as Component<LayoutProps>, {
    get data() {
      return props.layoutData?.[depth] ?? null
    },
    get boundaries() {
      return props.boundaries
    },
    get children() {
      return pageChain(chain, depth + 1, props)
    },
  })
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((key, i) => key === b[i])

function Level(props: {
  readonly nodes: Accessor<readonly SlotNode[]>
  readonly mount: KeepAliveViewMount
}): JSX.Element {
  const keys = createMemo(() => props.nodes().map((node) => node.key), [], { equals: sameKeys })
  return createComponent(For, {
    get each() {
      return keys()
    },
    children: (key: string) =>
      createComponent(Slot, { key, nodes: props.nodes, mount: props.mount }),
  })
}

function Slot(props: {
  readonly key: string
  readonly nodes: Accessor<readonly SlotNode[]>
  readonly mount: KeepAliveViewMount
}): JSX.Element {
  const { key, mount } = props
  const find = (): SlotNode | undefined => props.nodes().find((node) => node.key === key)
  const first = untrack(find)
  if (first === undefined) throw new Error(`[nifra/web-solid] no slot node "${key}"`)
  // The last node with this key stays while the slot is being removed with it.
  const node = createMemo((last: SlotNode) => find() ?? last, first)
  const state = createMemo(() => node().state)
  const hidden = createMemo(() => node().hidden)
  const slotProps = mount.propsOf(state)
  // A key keeps its depth, its wrappers and its chain: a page's key is one instance of one route, a
  // layout's key the layout every page under it shares.
  const { depth } = first
  const chain = mount.chainOf(first.state)
  const content = (): JSX.Element =>
    first.children === undefined
      ? pageChain(chain, depth, slotProps)
      : // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry above the page is a layout module's default export, a layout component
        createComponent(chain[depth] as Component<LayoutProps>, {
          get data() {
            return slotProps.layoutData?.[depth] ?? null
          },
          get boundaries() {
            return slotProps.boundaries
          },
          get children() {
            return createComponent(Level, { nodes: () => node().children ?? [], mount })
          },
        })
  if (!first.wrapped) return content()

  const slot: PageSlot = { hidden, hide: new Set(), show: new Set() }
  // A computation, not an effect: it runs as the tree changes, before the mount parks the page.
  createComputed(
    on(hidden, (now, before) => {
      if (before === undefined || now === before) return
      for (const callback of [...(now ? slot.hide : slot.show)]) callback()
    }),
  )
  return createComponent(Dynamic, {
    component: "div",
    "data-nifra-entry": "",
    style: CONTENTS,
    ref: mount.entry(key),
    get children() {
      return createComponent(Dynamic, {
        component: "div",
        "data-nifra-page": "",
        style: CONTENTS,
        ref: mount.page(key),
        get children() {
          return createComponent(PageContext.Provider, {
            value: slot,
            get children() {
              return withRouteContext(slotProps, content)
            },
          })
        },
      })
    },
  })
}

/** The keep-alive view. */
export function KeepAliveView(props: KeepAliveViewProps): JSX.Element {
  return withRouteContext(props.shown, () =>
    createComponent(Level, { nodes: props.tree, mount: props.mount }),
  )
}

/**
 * The tree of a server render: the chain as one path of slot nodes, the entries at `slots` inside
 * the slot wrappers, which is what the browser's first render builds from the same state.
 */
export function documentTree(
  chain: readonly unknown[],
  state: RouterState,
  slots: readonly number[],
): readonly SlotNode[] {
  const page = chain.length - 1
  let node: SlotNode = {
    key: "\0page",
    depth: page,
    state,
    hidden: false,
    wrapped: slots.includes(page),
  }
  for (let depth = page - 1; depth >= 0; depth--) {
    node = {
      key: `\0layout${depth}`,
      depth,
      state,
      hidden: false,
      wrapped: slots.includes(depth),
      children: [node],
    }
  }
  return [node]
}

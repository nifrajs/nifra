/**
 * The framework-free half of an adapter's keep-alive mount: the slot tree of each router state, the
 * parking a view commits each tree to, render props made once per state, and the per-parent bookkeeping
 * a view renders its slots from. Each adapter renders the slots its own way.
 */
import { createSlotParking, type KeepAliveRouter, type SlotNode, slotTree } from "../keep-alive.ts"
import type { RenderProps } from "../render-seam.ts"
import type { MountRouterOptions, RouterState } from "../router.ts"
import type { KeepAliveTable } from "./keep-alive-table.ts"

/** What a keep-alive view renders from and commits to: one per mount. */
export interface KeptMount {
  /** The slot tree of `state`, keeping each node of `previous` that did not change. */
  readonly tree: (
    state: RouterState,
    previous: readonly SlotNode[] | undefined,
  ) => readonly SlotNode[]
  /** The chain `state`'s route renders: its layouts' and its page's modules' default exports. */
  readonly chainOf: (state: RouterState) => readonly unknown[]
  /** The ref of a slot's outer wrapper. Stable per key. */
  readonly entry: (key: string) => (element: Element | null) => void
  /** The ref of a slot's inner wrapper, the element that is parked. Stable per key. */
  readonly page: (key: string) => (element: Element | null) => void
  /** After the view committed `tree`: park what it hid, restore what it showed again. */
  readonly after: (tree: readonly SlotNode[]) => void
}

/**
 * The parking of a keep-alive mount, set up before the view renders: each publish first puts back what
 * the next tree shows, while the page it hides is still laid out.
 */
export function keptMount(options: {
  readonly router: Pick<KeepAliveRouter, "beforePublish">
  readonly routes: MountRouterOptions["routes"]
  readonly matchChains?: MountRouterOptions["matchChains"]
  readonly keepAlive: KeepAliveTable
}): KeptMount {
  const { router, routes, keepAlive: table } = options
  const matchChains = options.matchChains ?? {}
  const parking = createSlotParking()
  let committed: readonly SlotNode[] | undefined
  router.beforePublish((next) => parking.before(slotTree(next, matchChains, table, committed)))
  return {
    tree: (state, previous) => slotTree(state, matchChains, table, previous),
    chainOf: (state) => routes[state.routeId] ?? [],
    entry: parking.entry,
    page: parking.page,
    after: (tree) => {
      committed = tree
      parking.after(tree)
    },
  }
}

/** `build`'s props for each router state, made once per state, so a memoized page gets the same object. */
export function propsByState(
  build: (state: RouterState) => RenderProps,
): (state: RouterState) => RenderProps {
  const props = new WeakMap<RouterState, RenderProps>()
  return (state) => {
    let held = props.get(state)
    if (held === undefined) {
      held = build(state)
      props.set(state, held)
    }
    return held
  }
}

/** The key {@link slotChildren} files a tree's top level under. */
export const SLOT_ROOT = "\0root"

/** Each parent's key to the slots under it, the tree's top level under {@link SLOT_ROOT}. */
export function slotChildren(tree: readonly SlotNode[]): Map<string, readonly SlotNode[]> {
  const nodes = new Map<string, readonly SlotNode[]>([[SLOT_ROOT, tree]])
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

/** What a layout adds to its `children` with `cloneElement`, for the slot it shows. */
export type SlotAdditions = Readonly<Record<string, unknown>> | undefined

const sameAdditions = (a: SlotAdditions, b: SlotAdditions): boolean => {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]))
}

/**
 * The additions each of `nodes` renders with, given a layout passed `shown`: a hidden slot keeps what it
 * last had, so its memo holds. `held` is one parent's, kept across its renders.
 */
export function additionsFor(
  held: Map<string, SlotAdditions>,
  nodes: readonly SlotNode[],
  shown: SlotAdditions,
): (node: SlotNode) => SlotAdditions {
  for (const key of held.keys()) if (!nodes.some((node) => node.key === key)) held.delete(key)
  return (node) => {
    const last = held.get(node.key)
    if (held.has(node.key) && (node.hidden || sameAdditions(last, shown))) return last
    held.set(node.key, shown)
    return shown
  }
}

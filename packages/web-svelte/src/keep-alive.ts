/**
 * @nifrajs/web-svelte/keep-alive - the client mount of an app with a `keepAlive` route, which the
 * generated client entry imports in place of `@nifrajs/web-svelte/client` (whose exports it carries).
 *
 * `KeepAlive.svelte` renders the page on screen and every page the router keeps, grouped by the layouts
 * they share; a kept page stays mounted and running outside the document. `onPageHide` / `onPageShow`
 * (from `@nifrajs/web-svelte/router`, re-exported here) let a page pause its timers meanwhile.
 */
import type { MountRouterOptions, RenderProps, RouterState } from "@nifrajs/web"
import { searchOfChain } from "@nifrajs/web/client"
import {
  createSlotParking,
  type KeepAliveRouter,
  type KeepAliveTable,
  type SlotNode,
  slotTree,
} from "@nifrajs/web/keep-alive"
import { hydrate as svelteHydrate } from "svelte"
import { setMountedRouter } from "./fetcher.ts"
import KeepAlive from "./KeepAlive.svelte"

export * from "./client.ts"
export { onPageHide, onPageShow } from "./router.ts"

/** `mountRouter`'s options in a keep-alive app: the generated entry adds where the wrappers go. */
export interface KeepAliveMountOptions extends MountRouterOptions {
  readonly router: KeepAliveRouter
  readonly keepAlive: KeepAliveTable
}

/** What `KeepAlive.svelte` and `Slot.svelte` render with: one per mount, on the server or the client. */
export interface KeepAliveMount {
  readonly tree: (
    state: RouterState,
    previous: readonly SlotNode[] | undefined,
  ) => readonly SlotNode[]
  readonly propsOf: (state: RouterState) => RenderProps
  readonly chainOf: (state: RouterState) => readonly unknown[]
  readonly entry: (key: string) => (element: Element | null) => void
  readonly page: (key: string) => (element: Element | null) => void
  readonly after: (tree: readonly SlotNode[]) => void
}

/**
 * Hydrate the keep-alive view. Its first render matches the server's (the same `KeepAlive` root, with
 * the slot wrappers the server rendered), so hydration reconciles the document as it is.
 */
export function mountRouter(options: KeepAliveMountOptions): void {
  const { router, routes, searchSchemas, container, keepAlive: table } = options
  const matchChains = options.matchChains ?? {}
  setMountedRouter(router)
  const parking = createSlotParking()
  let committed: readonly SlotNode[] | undefined
  router.beforePublish((next) => parking.before(slotTree(next, matchChains, table, committed)))
  const props = new WeakMap<RouterState, RenderProps>()
  const mount: KeepAliveMount = {
    tree: (state, previous) => slotTree(state, matchChains, table, previous),
    propsOf: (state) => {
      let held = props.get(state)
      if (held === undefined) {
        held = propsFor(state, searchSchemas, matchChains)
        props.set(state, held)
      }
      return held
    },
    chainOf: (state) => routes[state.routeId] ?? [],
    entry: parking.entry,
    page: parking.page,
    after: (tree) => {
      committed = tree
      parking.after(tree)
    },
  }
  const warning = assuranceWarning()
  const originalWarn = console.warn
  if (warning !== undefined) console.warn = (...args) => warning(args.map(String).join(" "))
  try {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the generated entry passes the element the server rendered the app into
    svelteHydrate(KeepAlive, { target: container as Element, props: { router, mount } })
  } finally {
    if (warning !== undefined) console.warn = originalWarn
  }
}

// What Router.svelte derives for the page on screen, for any state.
const propsFor = (
  state: RouterState,
  searchSchemas: MountRouterOptions["searchSchemas"],
  matchChains: NonNullable<MountRouterOptions["matchChains"]>,
): RenderProps => {
  const path = state.intercepted?.pagePath ?? state.path
  const q = path.indexOf("?")
  const matchChain = matchChains[state.routeId]
  const props: { -readonly [K in keyof RenderProps]: RenderProps[K] } = {
    data: state.data,
    actionData: state.actionData,
    pending: state.pending,
    params: state.params,
    path,
    search: searchOfChain(searchSchemas?.[state.routeId] ?? [], q === -1 ? "" : path.slice(q)),
  }
  if (state.layoutData !== undefined) props.layoutData = state.layoutData
  if (state.serverComponents !== undefined) props.serverComponents = state.serverComponents
  if (state.submission) props.submission = state.submission
  if (state.boundaries !== undefined) props.boundaries = state.boundaries
  if (matchChain !== undefined) props.matchChain = matchChain
  return props
}

function assuranceWarning(): ((message: string) => void) | undefined {
  const value = Reflect.get(globalThis, Symbol.for("nifra.hydration.assurance"))
  if (typeof value !== "object" || value === null) return undefined
  const callback: unknown = Reflect.get(value, "onWarning")
  if (typeof callback !== "function") return undefined
  return (message) => {
    Reflect.apply(callback, undefined, [message])
  }
}

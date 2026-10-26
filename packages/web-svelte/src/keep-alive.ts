/**
 * @nifrajs/web-svelte/keep-alive - the client mount of an app with a `keepAlive` route, which the
 * generated client entry imports in place of `@nifrajs/web-svelte/client` (whose exports it carries).
 *
 * `KeepAlive.svelte` renders the page on screen and every page the router keeps, grouped by the layouts
 * they share; a kept page stays mounted and running outside the document. `onPageHide` / `onPageShow`
 * (from `@nifrajs/web-svelte/router`, re-exported here) let a page pause its timers meanwhile.
 */
import type { MountRouterOptions, RenderProps, RouterState } from "@nifrajs/web"
import { keptMount, propsByState } from "@nifrajs/web/internal/keep-alive-mount"
import { routeProps } from "@nifrajs/web/internal/route-props-runtime"
import type { KeepAliveRouter, KeepAliveTable, SlotNode } from "@nifrajs/web/keep-alive"
import { hydrate as svelteHydrate } from "svelte"
import { setMountedRouter } from "./fetcher.ts"
import KeepAlive from "./KeepAlive.svelte"

export * from "./client.ts"
export { onPageHide, onPageShow, usePageVisibility } from "./router.ts"

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
  const { router, searchSchemas, container } = options
  const matchChains = options.matchChains ?? {}
  setMountedRouter(router)
  const mount: KeepAliveMount = {
    ...keptMount(options),
    propsOf: propsByState((state) => routeProps(state, searchSchemas, matchChains)),
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

function assuranceWarning(): ((message: string) => void) | undefined {
  const value = Reflect.get(globalThis, Symbol.for("nifra.hydration.assurance"))
  if (typeof value !== "object" || value === null) return undefined
  const callback: unknown = Reflect.get(value, "onWarning")
  if (typeof callback !== "function") return undefined
  return (message) => {
    Reflect.apply(callback, undefined, [message])
  }
}

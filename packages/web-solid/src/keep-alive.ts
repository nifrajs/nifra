/**
 * @nifrajs/web-solid/keep-alive - the client mount of an app with a `keepAlive` route, which the
 * generated client entry imports in place of `@nifrajs/web-solid/client` (whose exports it carries).
 *
 * One root renders the page on screen and every page the router keeps (`KeepAliveView`), grouped by
 * the layouts they share; the DOM half takes a hidden page out of the document. A hidden page keeps
 * running: `onPageHide`, `onPageShow` and `usePageVisibility` (from `@nifrajs/web-solid/router`) let
 * it pause. Unlike the plain mount, a route change does not remount the root: Solid updates the tree
 * in place, synchronously, so the DOM half runs right after each publish.
 */
import type { MountRouterOptions, RouterState } from "@nifrajs/web"
import { keptMount } from "@nifrajs/web/internal/keep-alive-mount"
import type { KeepAliveRouter, KeepAliveTable, SlotNode } from "@nifrajs/web/keep-alive"
import { createMemo, createSignal } from "solid-js"
import { hydrate as solidHydrate } from "solid-js/web"
import { setMountedRouter } from "./fetcher.ts"
import { KeepAliveView, type KeepAliveViewMount } from "./keep-alive-view.ts"
import { routeProps } from "./route-props.ts"

export * from "./client.ts"
export { onPageHide, onPageShow, usePageVisibility } from "./page-visibility.ts"

/** `mountRouter`'s options in a keep-alive app: the generated entry adds where the wrappers go. */
export interface KeepAliveMountOptions extends MountRouterOptions {
  readonly router: KeepAliveRouter
  readonly keepAlive: KeepAliveTable
}

/**
 * Hydrate the keep-alive view. Its first render matches the server's (the same view, with the slot
 * wrappers the server rendered), so hydration claims the document as it is.
 */
export function mountRouter(options: KeepAliveMountOptions): void {
  const { router, searchSchemas, container } = options
  const matchChains = options.matchChains ?? {}
  setMountedRouter(router)
  const kept = keptMount(options)

  let current: readonly SlotNode[] = []
  let publish: ((state: RouterState) => void) | undefined
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the generated entry passes the element the server rendered the app into
  solidHydrate(() => {
    const [state, setState] = createSignal(router.snapshot())
    publish = (next) => setState(() => next)
    const tree = createMemo(() => {
      current = kept.tree(state(), current)
      return current
    })
    const mount: KeepAliveViewMount = {
      ...kept,
      propsOf: (of) => routeProps(of, searchSchemas, matchChains, (read) => createMemo(read)),
    }
    return KeepAliveView({ tree, shown: mount.propsOf(state), mount })
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the generated entry passes the element the server rendered the app into
  }, container as Element)
  // Solid has updated the document by the time a publish returns: park what it hid, restore what it
  // showed again.
  const after = (): void => kept.after(current)
  after()
  router.subscribe(() => {
    publish?.(router.snapshot())
    after()
  })
}

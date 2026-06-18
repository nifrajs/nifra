import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
/**
 * @nifrajs/web-solid/client — Solid client runtime. `hydrate` hydrates a single SSR'd route;
 * `mountRouter` hydrates the initial route then drives navigation through a Solid signal — so a
 * same-route update (revalidation, a param change, an optimistic submit) updates **in place** via
 * fine-grained reactivity, preserving the layout chain + focus + scroll. Runs against Solid's client
 * build; kept in its own entry so SSR code never ships to the client bundle. No JSX — Solid's package
 * build is plain `tsc`, so this uses Solid's runtime functions directly, like `compose`.
 */
import { createSignal } from "solid-js"
import { hydrate as solidHydrate, render as solidRender } from "solid-js/web"
import { compose } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"

// The `_error` boundary chain element — defined in its own module, re-exported here so nifra's client
// codegen resolves it from `@nifrajs/web-solid/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

/** Hydrate a server-rendered Solid layout `chain` (with the loader `props`) inside `container`. */
export function hydrate(chain: readonly unknown[], props: RenderProps, container: unknown): void {
  solidHydrate(compose(chain, props), container as Element)
}

/**
 * Mount a Solid Router driven by the agnostic store. The first render *hydrates* the SSR'd chain. The
 * route's props are exposed as **getters over a signal** created inside the render root, so:
 *
 * - **Same route** (revalidation, a param change, an optimistic submit) — the snapshot signal is
 *   updated and only the components reading the changed props re-run; the layout chain stays mounted,
 *   so **focus and scroll are preserved**. This is the case the old "dispose + re-render on every
 *   navigation" implementation regressed.
 * - **Different route** — the matched chain genuinely changed (different page + layouts), so the root
 *   is disposed and the new chain is rendered. (Getter-props are a transparent reactive boundary, so
 *   they don't shift Solid's structural hydration keys — unlike a `<Show>`, which would.)
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, container } = options
  setMountedRouter(router) // expose it to createFetcher/useFetchers (same page, client-only)
  const el = container as Element

  let dispose: (() => void) | undefined
  let mountedRouteId: string | null = null
  // The setter for the currently-mounted route's reactive props — same-route settles push through it.
  let update: ((snapshot: ReturnType<typeof router.snapshot>) => void) | null = null

  const mount = (first: boolean): void => {
    const initial = router.snapshot()
    mountedRouteId = initial.routeId
    const renderer = first ? solidHydrate : solidRender
    dispose = renderer(() => {
      // Signal owned by THIS render root (so it's never ownerless). `props` are getters over it; a
      // same-route settle calls `update(snapshot)` and the reading components update in place — no
      // recompose, so the layout chain + focus + scroll survive. Cast bridges
      // `exactOptionalPropertyTypes` (a getter is always present, returning `undefined` when idle —
      // the documented "absent on idle" semantics for `submission`).
      const [snapshot, setSnapshot] = createSignal(initial)
      update = setSnapshot
      const props = {
        get data() {
          return snapshot().data
        },
        get actionData() {
          return snapshot().actionData
        },
        get pending() {
          return snapshot().pending
        },
        get submission() {
          return snapshot().submission
        },
      } as RenderProps
      // The matched chain is fixed for this mount (routeId is constant here); a route *change* disposes
      // and re-mounts below, so the root render fn reads no signal and never re-runs on its own.
      return compose(routes[initial.routeId] ?? [], props)()
    }, el)
  }

  mount(true)
  router.subscribe(() => {
    const snapshot = router.snapshot()
    if (snapshot.pending) return // skip the in-flight tick; act once settled
    if (snapshot.routeId === mountedRouteId) {
      update?.(snapshot) // same route → reactive in-place update (preserves layout/focus/scroll)
    } else {
      dispose?.() // route changed → tear down and render the new chain
      mount(false)
    }
  })
}

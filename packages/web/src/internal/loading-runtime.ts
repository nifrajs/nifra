/**
 * `_loading` pages. The router is untouched: {@link withLoading} only swaps the leaf of the state the
 * view is told while a navigation is pending, so no adapter knows a loading page exists.
 */
import type { MatchChain } from "../render-seam.ts"
import { type ClientRouter, type RouterState, redirectOf } from "../router.ts"

/** How long a navigation may run before its `_loading` page shows. Shorter loads swap straight to the
 * new page: a skeleton that flashes for a few frames reads as a glitch, not as feedback. */
export const LOADING_DELAY_MS = 120

/**
 * One route's row: its layout ids (outermost → innermost), and the `_loading` pages above it
 * (outermost → innermost), each paired with how many of those layouts sit at or above it.
 */
export type LoadingRoute = readonly [
  layoutIds: readonly string[],
  loadings: ReadonlyArray<readonly [id: string, layouts: number]>,
]

export interface LoadingOptions {
  /** Every route id → its {@link LoadingRoute} row. A route id absent here has no layouts. */
  readonly routes: Readonly<Record<string, LoadingRoute>>
  /** `_loading` id → a lazy import of its module. */
  readonly modules: Readonly<
    Record<string, () => Promise<{ readonly default?: unknown; readonly handle?: unknown }>>
  >
  /** The mounted view's route id → component chain table. The wrapper adds a chain per loading view. */
  readonly chains: Record<string, readonly unknown[]>
  /** Route id → search-schema chain, kept in step with {@link chains}. */
  readonly searchSchemas: Record<string, readonly unknown[]>
  /** Route id → what `useMatches` reports, kept in step with {@link chains}. */
  readonly matchChains?: Record<string, MatchChain>
  /** Override {@link LOADING_DELAY_MS}. */
  readonly delayMs?: number
  /** Where a navigation goes when it fails after its loading page was shown. Defaults to a document
   * load of the path. */
  readonly fallback?: (path: string) => void
}

const pathnameOf = (path: string): string => {
  const q = path.indexOf("?")
  return q === -1 ? path : path.slice(0, q)
}

/**
 * Shows the innermost `_loading` within the layouts both pages share once a navigation outlasts
 * `delayMs`. `navigate` settles when it shows, so a view transition does not hold across the wait; a
 * later failure goes to `fallback`, or replaces the entry for a redirect out of the app.
 */
export function withLoading(router: ClientRouter, options: LoadingOptions): ClientRouter {
  const { routes, modules, chains, searchSchemas, matchChains } = options
  const delayMs = options.delayMs ?? LOADING_DELAY_MS
  const fallback = options.fallback ?? ((path: string) => location.assign(path))

  const listeners = new Set<() => void>()
  const components = new Map<string, unknown>()
  const handles = new Map<string, unknown>()
  const inflight = new Map<string, Promise<void>>()
  /** Bumped per navigation through this wrapper - the latest one owns the page slot. */
  let seq = 0
  /** The loading view on screen (its chain id), and the navigation it belongs to. */
  let shown: string | undefined
  let owner = 0
  // One derived state per (router state, loading view) so `snapshot` is referentially stable.
  let base: RouterState | undefined
  let derived: RouterState | undefined

  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const load = (id: string): Promise<void> => {
    if (components.has(id)) return Promise.resolve()
    const running = inflight.get(id)
    if (running !== undefined) return running
    const importer = modules[id]
    const job = (
      importer === undefined ? Promise.reject(new Error(`no _loading module "${id}"`)) : importer()
    )
      .then((mod) => {
        if (mod.default !== undefined) components.set(id, mod.default)
        handles.set(id, mod.handle)
      })
      .finally(() => {
        inflight.delete(id)
      })
    inflight.set(id, job)
    return job
  }

  const pick = (
    fromId: string,
    toId: string,
  ): { readonly id: string; readonly shared: number } | undefined => {
    const target = routes[toId]
    if (target === undefined) return undefined
    const current = routes[fromId]?.[0] ?? []
    const [layouts, candidates] = target
    let shared = 0
    while (
      shared < current.length &&
      shared < layouts.length &&
      current[shared] === layouts[shared]
    ) {
      shared++
    }
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i]
      if (candidate !== undefined && candidate[1] <= shared) return { id: candidate[0], shared }
    }
    return undefined
  }

  const snapshot = (): RouterState => {
    const state = router.snapshot()
    if (shown === undefined || !state.pending) return state
    if (base !== state || derived === undefined || derived.routeId !== shown) {
      base = state
      // The layouts keep their data and the URL-derived fields stay the current page's; only the leaf
      // changes, and it has no loader data of its own.
      derived = { ...state, routeId: shown, data: null }
    }
    return derived
  }

  const navigate = (path: string): Promise<void> => {
    const match = router.match(path)
    // Unmatched: the router ignores it, so whatever is on screen stays as it is.
    if (match === null) return router.navigate(path)
    const mine = ++seq
    const from = router.snapshot()
    const choice =
      pathnameOf(from.path) === pathnameOf(path) ? undefined : pick(from.routeId, match.routeId)
    // NUL-prefixed: a chain id no route file can produce.
    const view =
      choice === undefined ? undefined : `\0${choice.id}\0${from.routeId}\0${choice.shared}`
    const wasShown = shown !== undefined
    // A newer navigation that would show the same view keeps it, rather than flashing the old page.
    const carried = wasShown && shown === view
    if (carried) owner = mine
    else shown = undefined

    const done = router.navigate(path)
    if (choice === undefined || view === undefined) {
      if (wasShown) emit()
      return done
    }

    let finished = false
    let revealed = carried
    let timer: ReturnType<typeof setTimeout> | undefined
    const reveal = new Promise<void>((resolve) => {
      if (carried) {
        setTimeout(resolve, 0)
        return
      }
      const show = (): void => {
        if (finished || mine !== seq || !router.snapshot().pending) return
        const component = components.get(choice.id)
        if (component === undefined) return
        chains[view] ??= [...(chains[from.routeId] ?? []).slice(0, choice.shared), component]
        // The current route's schemas: the URL is still its URL, so its layouts read the same search.
        searchSchemas[view] ??= searchSchemas[from.routeId] ?? []
        if (matchChains !== undefined) {
          const current = matchChains[from.routeId]
          matchChains[view] ??= {
            ids: [...(current?.ids ?? []).slice(0, choice.shared), choice.id],
            handles: [...(current?.handles ?? []).slice(0, choice.shared), handles.get(choice.id)],
          }
        }
        shown = view
        owner = mine
        revealed = true
        emit()
        // A macrotask later, so the view has committed the loading page before the caller resumes.
        setTimeout(resolve, 0)
      }
      const ready = load(choice.id)
      // A `_loading` module that fails to load costs only the loading page, never the navigation.
      ready.catch(() => {})
      timer = setTimeout(
        () => {
          ready.then(show, () => {})
        },
        wasShown ? 0 : delayMs,
      )
    })

    const finish = (): void => {
      finished = true
      clearTimeout(timer)
      if (owner !== mine || shown === undefined) return
      shown = undefined
      // A navigation that ended without publishing (superseded inside the router) leaves the store
      // pending: tell the view the page slot is the current page's again.
      if (router.snapshot().pending) emit()
    }
    const settled = done.then(finish, (error: unknown) => {
      finish()
      if (!revealed) throw error
      const to = redirectOf(error)
      if (to === undefined) fallback(path)
      else location.replace(to)
    })
    return Promise.race([settled, reveal])
  }

  return {
    ...router,
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      const unsubscribe = router.subscribe(listener)
      return () => {
        listeners.delete(listener)
        unsubscribe()
      }
    },
    navigate,
    prefetch(path) {
      // Warm the loading pages a navigation there could show, alongside the route itself.
      const match = router.match(path)
      if (match !== null) {
        for (const [id] of routes[match.routeId]?.[1] ?? []) load(id).catch(() => {})
      }
      return router.prefetch(path)
    },
  }
}

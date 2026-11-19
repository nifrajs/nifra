// `import type` + a local re-export, NOT `export type { … } from "@nifrajs/web"`: that form leaves a
// bare `import "@nifrajs/web"` in the output, which pulls the server graph into the browser under
// Vite's dev server. Sourced from the ROOT so the generated `RouteTable` augmentation applies.
import type {
  Blocker,
  BlockerFunction,
  BlockerState,
  NavigateFunction,
  ParamsOfFrom,
  RouteFrom,
  SearchOfFrom,
  UIMatch,
} from "@nifrajs/web"
// `/client`, not the root - these are DOM values, and the root's graph carries the
// server, which Vite's dev server evaluates rather than tree-shakes.
import { IDLE_BLOCKER, registerBlocker } from "@nifrajs/web/client"
// Its own subpath, so an app that never calls `useMatches` never bundles it.
import { chainMatches } from "@nifrajs/web/internal/matches-runtime"
import { navigateNow } from "@nifrajs/web/internal/navigate-runtime"
/**
 * `@nifrajs/web-solid/router` - Solid routing bindings over the agnostic `@nifrajs/web` history layer:
 * `useNavigate` (programmatic navigation), `useBlocker` (the unsaved-changes guard), and `useSearch`
 * (the route's typed, validated search, as a reactive accessor). Navigation goes through `@nifrajs/web`'s
 * DOM-free bridges (`getBrowserNavigate` / `registerBlocker`, populated by `installHistory`); `useSearch`
 * reads the accessor `compose` provides on SSR + client mount alike. Imports only `solid-js`. No JSX.
 */
import { type Accessor, createMemo, createSignal, onCleanup, useContext } from "solid-js"
import { PageContext } from "./page-visibility.ts"
import { RenderPropsContext, SearchContext } from "./router-context.ts"

export { href, rawHref } from "@nifrajs/web/client"
export { onPageHide, onPageShow, usePageVisibility } from "./page-visibility.ts"
export type { RouteSlotController, RouteSlotProps } from "./route-slot.tsx"
export { RouteSlot, useRouteSlot } from "./route-slot.tsx"
export type { Blocker, BlockerFunction, BlockerState, NavigateFunction, UIMatch }
export { RenderPropsContext, SearchContext }

// Frozen empty search + a stable accessor for a `useSearch` used outside a nifra route tree.
const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_SEARCH_ACCESSOR: Accessor<Record<string, unknown>> = () => EMPTY_SEARCH

/** The current route's validated search accessor, provided by `compose` on SSR + client mount alike
 * (derived from the URL via the shared `searchOfChain`). Read via {@link useSearch}.
 *
 * A `globalThis` singleton: in dev this module is evaluated twice in one process (the app's server
 * code under Bun provides; route modules through Vite's SSR runner read), and Solid matches provider
 * to reader by context object identity - two `createContext` results make `useSearch` SSR-render its
 * empty default in dev. */
const NO_MATCHES: readonly UIMatch[] = Object.freeze([])

/**
 * The rendered chain - each layout, then the page - with the URL prefix, params and loader data each
 * one owns, plus its `handle` export, as a reactive accessor. The same list on the server render and
 * the client mount, so a layout can render breadcrumbs from its children's `handle`s without a
 * hydration mismatch; it updates in place when a same-route navigation settles.
 *
 * ```tsx
 * export const handle = { crumb: "Settings" }
 * const matches = useMatches()
 * const crumbs = () => matches().flatMap((m) => (m.handle as { crumb?: string } | undefined)?.crumb ?? [])
 * ```
 */
export function useMatches(): Accessor<readonly UIMatch[]> {
  const props = useContext(RenderPropsContext)
  if (props === null) return () => NO_MATCHES
  return createMemo(() => chainMatches(props))
}

// Frozen empty params + a stable accessor for a `useParams` used outside a nifra route tree.
const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({})
const EMPTY_PARAMS_ACCESSOR: Accessor<Readonly<Record<string, string>>> = () => EMPTY_PARAMS

/**
 * The matched route's decoded path params as a reactive accessor, typed from the generated route table:
 * `useParams("/users/:id")` is `{ readonly id: string }`. The argument only names the route for the
 * compiler (nothing is read from it at runtime), and a pattern the table does not hold is a compile
 * error. SSR-correct: the same value on the server render and the client mount.
 *
 * ```tsx
 * const params = useParams("/users/:id") // Accessor<{ id: string }>
 * return <span>{params().id}</span>
 * ```
 */
export function useParams<K extends RouteFrom>(from: K): Accessor<ParamsOfFrom<K>>
export function useParams(): unknown {
  const props = useContext(RenderPropsContext)
  return props === null ? EMPTY_PARAMS_ACCESSOR : () => props.params ?? EMPTY_PARAMS
}

/**
 * The route's validated search params as a reactive accessor - the SAME value the loader received as `ctx.search`,
 * typed from the generated route table: `useSearch("/reports")` is that route's `searchSchema` output.
 * The argument only names the route for the compiler (nothing is read from it at runtime), and a pattern
 * the table does not hold is a compile error. SSR-correct: the value is derived from the URL identically
 * on the server and on each client navigation, so a value rendered from it doesn't flash on hydration.
 * Hostile input already failed closed to the schema's defaults at match time.
 *
 * ```tsx
 * const search = useSearch("/reports") // Accessor<{ page: number }>
 * return <span>{search().page}</span>
 * ```
 */
export function useSearch<K extends RouteFrom>(from: K): Accessor<SearchOfFrom<K>>
export function useSearch(): unknown {
  return useContext(SearchContext) ?? EMPTY_SEARCH_ACCESSOR
}

/** Get the {@link NavigateFunction} (an `Href` from `href()` or `rawHref()`, or a history delta).
 * Resolves the browser navigate at call time, so it works as soon as `installHistory` has run and no-ops
 * before then / on the server. */
export function useNavigate(): NavigateFunction {
  return navigateNow
}

/**
 * Guard navigation away from a page with unsaved work, confirming with your OWN async UI. Mirrors
 * react-router's `useBlocker`: pass a boolean or a `({ currentLocation, nextLocation }) => boolean`
 * predicate, and get back a reactive {@link Blocker} accessor. When a navigation (an anchor click,
 * `useNavigate`, or a browser back/forward) is intercepted, `blocker().state` becomes `"blocked"` and
 * `proceed`/`reset` go live - show a dialog and call `proceed()` to continue or `reset()` to stay put.
 * It also arms the browser's native "Leave site?" prompt on tab close / reload. Idle on the server,
 * before hydration, and while a `keepAlive` page is hidden.
 *
 * The component body runs once, so to track a CHANGING flag pass a function -
 * `useBlocker(() => isDirty())` - not a bare signal accessor's current value. A constant boolean is fine.
 */
export function useBlocker(shouldBlock: boolean | BlockerFunction): Accessor<Blocker> {
  const [blocker, setBlocker] = createSignal<Blocker>(IDLE_BLOCKER)
  const slot = useContext(PageContext)
  onCleanup(
    registerBlocker(
      (args) =>
        slot?.hidden() !== true &&
        (typeof shouldBlock === "function" ? shouldBlock(args) : shouldBlock),
      setBlocker,
    ),
  )
  return blocker
}

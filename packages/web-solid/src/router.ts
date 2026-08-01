import type { InferOutput, StandardSchemaV1 } from "@nifrajs/core/server"
import {
  type Blocker,
  type BlockerFunction,
  getBrowserNavigate,
  IDLE_BLOCKER,
  type NavigateOptions,
  registerBlocker,
} from "@nifrajs/web"
/**
 * `@nifrajs/web-solid/router` - Solid routing bindings over the agnostic `@nifrajs/web` history layer:
 * `useNavigate` (programmatic navigation), `useBlocker` (the unsaved-changes guard), and `useSearch`
 * (the route's typed, validated search, as a reactive accessor). Navigation goes through `@nifrajs/web`'s
 * DOM-free bridges (`getBrowserNavigate` / `registerBlocker`, populated by `installHistory`); `useSearch`
 * reads the accessor `compose` provides on SSR + client mount alike. Imports only `solid-js`. No JSX.
 */
import { type Accessor, createContext, createSignal, onCleanup, useContext } from "solid-js"

export type { Blocker, BlockerFunction, BlockerState } from "@nifrajs/web"

// Frozen empty search + a stable accessor for a `useSearch` used outside a nifra route tree.
const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_SEARCH_ACCESSOR: Accessor<Record<string, unknown>> = () => EMPTY_SEARCH

/** The current route's validated search accessor, provided by `compose` on SSR + client mount alike
 * (derived from the URL via the shared `searchOfChain`). Read via {@link useSearch}. */
export const SearchContext = createContext<Accessor<Record<string, unknown>>>()

/**
 * The route's typed, validated search params as a reactive accessor - the SAME value the loader received
 * as `ctx.search`. SSR-correct: `compose` provides it from the URL server-side and from the identical
 * client-mount derivation, so a value rendered from it doesn't flash on hydration. Call it to read the
 * current search (`useSearch()().page`); it updates in place on a same-route navigation. Pass the route's
 * `searchSchema` as the type argument for its output type.
 *
 * ```tsx
 * const search = useSearch<typeof searchSchema>() // Accessor<{ page: number }>
 * return <span>{search().page}</span>
 * ```
 */
export function useSearch<Schema extends StandardSchemaV1 | undefined = undefined>(): Accessor<
  Schema extends StandardSchemaV1 ? InferOutput<Schema> : Record<string, unknown>
> {
  return (useContext(SearchContext) ?? EMPTY_SEARCH_ACCESSOR) as Accessor<
    Schema extends StandardSchemaV1 ? InferOutput<Schema> : Record<string, unknown>
  >
}

/** A programmatic navigate: a string path (push, or replace via `{ replace: true }`) or a history delta
 * (`-1`/`1`). A no-op on the server / before hydration (use a `<a href>` there). */
export type NavigateFunction = (to: string | number, options?: NavigateOptions) => void

/** Get the {@link NavigateFunction}. Resolves the browser navigate at call time, so it works as soon as
 * `installHistory` has run and no-ops before then / on the server. */
export function useNavigate(): NavigateFunction {
  return (to, options) => {
    const navigate = getBrowserNavigate()
    if (navigate !== undefined) navigate(to, options)
  }
}

/**
 * Guard navigation away from a page with unsaved work, confirming with your OWN async UI. Mirrors
 * react-router's `useBlocker`: pass a boolean or a `({ currentLocation, nextLocation }) => boolean`
 * predicate, and get back a reactive {@link Blocker} accessor. When a navigation (an anchor click,
 * `useNavigate`, or a browser back/forward) is intercepted, `blocker().state` becomes `"blocked"` and
 * `proceed`/`reset` go live - show a dialog and call `proceed()` to continue or `reset()` to stay put.
 * It also arms the browser's native "Leave site?" prompt on tab close / reload. Idle on the server and
 * before hydration.
 *
 * The component body runs once, so to track a CHANGING flag pass a function -
 * `useBlocker(() => isDirty())` - not a bare signal accessor's current value. A constant boolean is fine.
 */
export function useBlocker(shouldBlock: boolean | BlockerFunction): Accessor<Blocker> {
  const [blocker, setBlocker] = createSignal<Blocker>(IDLE_BLOCKER)
  onCleanup(
    registerBlocker(
      (args) => (typeof shouldBlock === "function" ? shouldBlock(args) : shouldBlock),
      setBlocker,
    ),
  )
  return blocker
}

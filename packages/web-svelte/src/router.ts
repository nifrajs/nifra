import type { InferOutput, StandardSchemaV1 } from "@nifrajs/core/server"
import {
  type Blocker,
  type BlockerFunction,
  getBrowserNavigate,
  IDLE_BLOCKER,
  type NavigateFunction,
  type NavigateOptions,
  type NavigateTargetInput,
  registerBlocker,
  resolveNavigate,
} from "@nifrajs/web"
import { getContext } from "svelte"
/**
 * `@nifrajs/web-svelte/router` - Svelte routing bindings over the agnostic `@nifrajs/web` history layer,
 * as plain `.ts` (no runes/compiler needed): `useNavigate` (programmatic navigation), `useBlocker` (the
 * unsaved-changes guard), and `useSearch` (the route's typed, validated search, as a reactive accessor).
 * Navigation goes through `@nifrajs/web`'s DOM-free bridges (`getBrowserNavigate` / `registerBlocker`,
 * populated by `installHistory`); `useSearch` reads the accessor `Chain.svelte` provides via Svelte
 * context on SSR + client alike. Idle before hydration (native `<a>` navigation still works). SSR-safe.
 */
import { type Readable, readable } from "svelte/store"

export type { Blocker, BlockerFunction, BlockerState, NavigateFunction } from "@nifrajs/web"

// Must match the string key `Chain.svelte` passes to `setContext` (a string avoids a `.svelte` → `.ts`
// import that wouldn't resolve once the .svelte is copied to dist).
const SEARCH_KEY = "@nifrajs/web-svelte:search"
const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_SEARCH_ACCESSOR = (): Record<string, unknown> => EMPTY_SEARCH

/**
 * The route's typed, validated search params as a reactive accessor - the SAME value the loader received
 * as `ctx.search`. SSR-correct: `Chain.svelte` provides it from the URL server-side and from the
 * identical client derivation, so a value rendered from it doesn't flash on hydration. Call it (in a
 * `$derived` or the template) to read the current search - it updates on navigation. Pass the route's
 * `searchSchema` as the type argument for its output type.
 *
 * ```svelte
 * <script>
 *   const search = useSearch() // () => { page: number, ... }
 * </script>
 * <span>{search().page}</span>
 * ```
 */
export function useSearch<
  Schema extends StandardSchemaV1 | undefined = undefined,
>(): () => Schema extends StandardSchemaV1 ? InferOutput<Schema> : Record<string, unknown> {
  const get = getContext<(() => Record<string, unknown>) | undefined>(SEARCH_KEY)
  return (get ?? EMPTY_SEARCH_ACCESSOR) as () => Schema extends StandardSchemaV1
    ? InferOutput<Schema>
    : Record<string, unknown>
}

/** Get the {@link NavigateFunction} (a string path, a history delta, or a typed `{ to, search }` object).
 * Resolves the browser navigate at call time, so it works as soon as `installHistory` has run and no-ops
 * before then / on the server. */
export function useNavigate(): NavigateFunction {
  return ((to: string | number | NavigateTargetInput, options?: NavigateOptions) => {
    const navigate = getBrowserNavigate()
    if (navigate === undefined) return
    const resolved = resolveNavigate(to, options)
    navigate(resolved.to, resolved.options)
  }) as NavigateFunction
}

/**
 * Guard navigation away from a page with unsaved work, confirming with your OWN async UI. Mirrors
 * react-router's `useBlocker`: pass a boolean or a `({ currentLocation, nextLocation }) => boolean`
 * predicate, and get back a {@link Blocker} store (read with `$blocker`). When a navigation (an anchor
 * click, `useNavigate`, or a browser back/forward) is intercepted, `$blocker.state` becomes `"blocked"`
 * and `proceed`/`reset` go live - show a dialog and call `proceed()` to continue or `reset()` to stay.
 * It also arms the browser's native "Leave site?" prompt on tab close / reload. Idle on the server and
 * before hydration.
 *
 * The store is created once, so to track a CHANGING flag pass a function - `useBlocker(() => dirty)` -
 * re-evaluated at navigation time. A constant boolean is fine as-is.
 */
export function useBlocker(shouldBlock: boolean | BlockerFunction): Readable<Blocker> {
  return readable<Blocker>(IDLE_BLOCKER, (set) =>
    registerBlocker(
      (args) => (typeof shouldBlock === "function" ? shouldBlock(args) : shouldBlock),
      set,
    ),
  )
}

import type { InferOutput, StandardSchemaV1 } from "@nifrajs/core/server"
// `import type` + a local re-export, NOT `export type { … } from "@nifrajs/web"`: that form leaves a
// bare `import "@nifrajs/web"` in the output, which pulls the server graph into the browser under
// Vite's dev server. Sourced from the ROOT so the generated `RouteSearch` augmentation applies.
import type {
  Blocker,
  BlockerFunction,
  BlockerState,
  NavigateFunction,
  NavigateOptions,
  NavigateTargetInput,
} from "@nifrajs/web"
// `/client`, not the root - these are DOM values, and the root's graph carries the
// server, which Vite's dev server evaluates rather than tree-shakes.
import {
  getBrowserNavigate,
  IDLE_BLOCKER,
  registerBlocker,
  resolveNavigate,
} from "@nifrajs/web/client"
/**
 * `@nifrajs/web-preact/router` - Preact routing bindings over the agnostic `@nifrajs/web` history layer:
 * `useNavigate` (programmatic navigation), `useBlocker` (the unsaved-changes guard), and `useSearch`
 * (the route's typed, validated search). Navigation goes through `@nifrajs/web`'s DOM-free bridges
 * (`getBrowserNavigate` / `registerBlocker`, populated by `installHistory`); `useSearch` reads the value
 * `compose` provides on SSR + client mount alike. Client-safe (no `preact-render-to-string`). No JSX.
 */
import { createContext } from "preact"
import { useCallback, useContext, useEffect, useRef, useState } from "preact/compat"

export type { Blocker, BlockerFunction, BlockerState, NavigateFunction }

// Frozen empty search so the default context value has a stable reference.
const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})

/** The current route's validated search, provided by `compose` on SSR + client mount alike (derived from
 * the URL via the shared `searchOfChain`). `{}` outside a nifra route tree. Read via {@link useSearch}.
 *
 * A `globalThis` singleton: in dev this module is evaluated twice in one process (the app's server
 * code under Bun provides; route modules through Vite's SSR runner read), and Preact matches provider
 * to reader by context object identity - two `createContext` results make `useSearch` SSR-render its
 * empty default in dev. */
const SEARCH_CONTEXT_SLOT = Symbol.for("nifra.web-preact.search-context")
const searchContextSlot = globalThis as {
  [SEARCH_CONTEXT_SLOT]?: ReturnType<typeof createContext<Record<string, unknown>>>
}
export const SearchContext =
  searchContextSlot[SEARCH_CONTEXT_SLOT] ?? createContext<Record<string, unknown>>(EMPTY_SEARCH)
searchContextSlot[SEARCH_CONTEXT_SLOT] = SearchContext

/**
 * The route's typed, validated search params - the SAME value the loader received as `ctx.search`.
 * SSR-correct: `compose` provides it from the URL server-side and from the identical derivation on the
 * client mount, so a value rendered from it doesn't flash on hydration. Hostile input already failed
 * closed to the schema's defaults at match time. Pass the route's `searchSchema` as the type argument to
 * get its output type; bare, it's the raw parsed query (`Record<string, unknown>`).
 *
 * ```tsx
 * export const searchSchema = v.object({ page: v.optional(v.fallback(v.number(), 1), 1) })
 * const { page } = useSearch<typeof searchSchema>() // page: number
 * ```
 */
export function useSearch<
  Schema extends StandardSchemaV1 | undefined = undefined,
>(): Schema extends StandardSchemaV1 ? InferOutput<Schema> : Record<string, unknown> {
  return useContext(SearchContext) as Schema extends StandardSchemaV1
    ? InferOutput<Schema>
    : Record<string, unknown>
}

/** Get the {@link NavigateFunction} (a string path, a history delta, or a typed `{ to, search }` object).
 * Stable across renders; resolves the browser navigate at call time, so it works as soon as
 * `installHistory` has run and no-ops before then / on the server. */
export function useNavigate(): NavigateFunction {
  return useCallback((to: string | number | NavigateTargetInput, options?: NavigateOptions) => {
    const navigate = getBrowserNavigate()
    if (navigate === undefined) return
    const resolved = resolveNavigate(to, options)
    navigate(resolved.to, resolved.options)
  }, []) as NavigateFunction
}

/**
 * Guard navigation away from a page with unsaved work, confirming with your OWN async UI. Mirrors
 * react-router's `useBlocker`: pass a boolean (`useBlocker(isDirty)`) or a predicate
 * `({ currentLocation, nextLocation }) => boolean`, and get back a {@link Blocker}. When a navigation
 * (an anchor click, `useNavigate`, or a browser back/forward) is intercepted, `blocker.state` becomes
 * `"blocked"` and `proceed`/`reset` go live - render a dialog and call `proceed()` to continue or
 * `reset()` to stay put. It also arms the browser's native "Leave site?" prompt on tab close / reload.
 * Idle (never blocks) on the server and before hydration.
 */
export function useBlocker(shouldBlock: boolean | BlockerFunction): Blocker {
  const [blocker, setBlocker] = useState<Blocker>(IDLE_BLOCKER)
  // Track the latest predicate in a ref (updated every render) so the single registration always sees
  // current component state without re-registering (which would drop an open prompt).
  const shouldBlockRef = useRef(shouldBlock)
  shouldBlockRef.current = shouldBlock
  useEffect(
    () =>
      registerBlocker((args) => {
        const current = shouldBlockRef.current
        return typeof current === "function" ? current(args) : current
      }, setBlocker),
    [],
  )
  return blocker
}

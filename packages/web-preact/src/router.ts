import {
  type Blocker,
  type BlockerFunction,
  getBrowserNavigate,
  IDLE_BLOCKER,
  type NavigateOptions,
  registerBlocker,
} from "@nifrajs/web"
/**
 * `@nifrajs/web-preact/router` - Preact routing bindings over the agnostic `@nifrajs/web` history layer:
 * `useNavigate` (programmatic navigation) and `useBlocker` (the unsaved-changes guard). Both go through
 * `@nifrajs/web`'s DOM-free bridges (`getBrowserNavigate` / `registerBlocker`, populated by
 * `installHistory`), so this module imports only `preact/compat` and a route component can use these on
 * the server and the client. Idle before hydration (native `<a>` navigation still works). No JSX.
 */
import { useCallback, useEffect, useRef, useState } from "preact/compat"

export type { Blocker, BlockerFunction, BlockerState } from "@nifrajs/web"

/** A programmatic navigate: a string path (push, or replace via `{ replace: true }`) or a history delta
 * (`-1`/`1`). A no-op on the server / before hydration (use a `<a href>` there). */
export type NavigateFunction = (to: string | number, options?: NavigateOptions) => void

/** Get the {@link NavigateFunction}. Stable across renders; resolves the browser navigate at call time,
 * so it works as soon as `installHistory` has run and no-ops before then / on the server. */
export function useNavigate(): NavigateFunction {
  return useCallback((to, options) => {
    const navigate = getBrowserNavigate()
    if (navigate !== undefined) navigate(to, options)
  }, [])
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

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
 * `useNavigate` (programmatic navigation) and `useBlocker` (the unsaved-changes guard). Both go through
 * `@nifrajs/web`'s DOM-free bridges (`getBrowserNavigate` / `registerBlocker`, populated by
 * `installHistory`), so this module imports only `solid-js` (never `solid-js/web`) and works on the
 * server and the client. Idle before hydration (native `<a>` navigation still works). No JSX.
 */
import { type Accessor, createSignal, onCleanup } from "solid-js"

export type { Blocker, BlockerFunction, BlockerState } from "@nifrajs/web"

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

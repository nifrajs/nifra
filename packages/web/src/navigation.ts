/**
 * `@nifrajs/web` navigation bridge — a tiny, DOM-free seam that lets an adapter's `useNavigate`
 * (a route component, which must import only from the agnostic `@nifrajs/web` main entry — never the
 * DOM-only `/client`) reach the browser's history-aware navigate, WITHOUT the route component pulling
 * `@nifrajs/web/client` (and its `document`/`history` access) into a bundle that also renders on the
 * server.
 *
 * The browser layer (`installHistory`, in `./client.ts`) populates this on setup and clears it on
 * teardown; a framework binding reads it via {@link getBrowserNavigate}. Module-level singleton — the
 * browser mounts exactly one app per page (the same convention the adapters' `setMountedRouter` uses).
 * On the server (and before hydration) the getter returns `undefined`, so a binding degrades to the
 * native `<a href>` full-page navigation — progressive enhancement, no throw.
 */

import { serializeSearch } from "./search.ts"

/** Options for a programmatic navigation. */
export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one (like `history.replaceState`). */
  readonly replace?: boolean
}

/**
 * The augmentable route -> search-type map for typed cross-route navigation. Empty by default (so an
 * object-form navigate to any path is allowed with a loose `search`). A build step (`nifra sync-routes`)
 * OR the app declares one entry per route path against its `searchSchema` output:
 *
 * ```ts
 * declare module "@nifrajs/web" {
 *   interface RouteSearch {
 *     "/reports": { page: number; q: string }
 *   }
 * }
 * ```
 *
 * With that, `navigate({ to: "/reports", search: { page: 2 } })` type-checks `search` against
 * `/reports`'s schema, and a wrong shape is a compile error. See {@link NavigateTarget}.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target - empty by design, apps/codegen fill it.
export interface RouteSearch {}

/**
 * The `search` type for a navigate to `To`: the route's schema output when `To` is a mapped
 * {@link RouteSearch} key, otherwise the loose `Record<string, unknown>` (so a navigate to any path is
 * always allowed). Keyed on `To` rather than a union, so a mapped route can't fall back to the loose form
 * with a wrong shape - `navigate({ to: "/reports", search: { page: "x" } })` is a compile error.
 */
export type NavigateSearchOf<To extends string> = To extends keyof RouteSearch
  ? RouteSearch[To]
  : Record<string, unknown>

/** The runtime shape of an object-form navigate target (loose - the typed narrowing lives in
 * {@link NavigateFunction}'s generic call signature). `to` is a bare pathname; `search` is serialized
 * onto it; `replace` folds into the options. */
export interface NavigateTargetInput {
  readonly to: string
  readonly search?: Record<string, unknown>
  readonly replace?: boolean
}

/**
 * A programmatic navigate, shared by every adapter's `useNavigate`. Three forms: a string path (push, or
 * replace via `{ replace: true }`), a history delta (`-1`/`1`), or an object target `{ to, search, replace }`
 * whose `search` is typed against `to`'s route schema via {@link NavigateSearchOf} (a wrong shape for a
 * mapped route is a compile error; an unmapped path takes a loose `search`). The object form's `search` is
 * serialized onto `to`. A no-op on the server / before hydration.
 */
export interface NavigateFunction {
  (to: string | number, options?: NavigateOptions): void
  <To extends string>(target: {
    readonly to: To
    readonly search?: NavigateSearchOf<To>
    readonly replace?: boolean
  }): void
}

/**
 * Normalize a navigate argument to the bridge's `(to, options)`: a string path or history-delta passes
 * through; an object target has its `search` serialized onto `to` and its `replace` folded into the
 * options. The one place the object form becomes a URL, so every adapter's `navigate` resolves it
 * identically.
 */
export function resolveNavigate(
  to: string | number | NavigateTargetInput,
  options?: NavigateOptions,
): { readonly to: string | number; readonly options: NavigateOptions | undefined } {
  if (typeof to !== "object") return { to, options }
  const query = to.search !== undefined ? serializeSearch(to.search) : ""
  return { to: to.to + query, options: to.replace === true ? { replace: true } : options }
}

/**
 * A history-aware navigate. A **string** `to` is a same-origin path (`/users/7?tab=a`) navigated to
 * (push, or replace with `{ replace: true }`); a **number** is a history delta (`-1` back, `1`
 * forward), matching the browser's `history.go`. Registered by `installHistory`.
 */
export type BrowserNavigate = (to: string | number, options?: NavigateOptions) => void

// The active browser navigate (set by `installHistory`, cleared on teardown). Module-scoped: one app
// per page; absent on the server and before hydration.
let browserNavigate: BrowserNavigate | undefined

/** Register (or clear, with `undefined`) the browser navigate — called by `installHistory`. Not for
 * app use. */
export function setBrowserNavigate(navigate: BrowserNavigate | undefined): void {
  browserNavigate = navigate
}

/** The active browser navigate, or `undefined` on the server / before `installHistory` has run. A
 * binding calls it when present and falls back to native navigation otherwise. */
export function getBrowserNavigate(): BrowserNavigate | undefined {
  return browserNavigate
}

/** A parsed navigation target the {@link BlockerFunction} decides on. `pathname`/`search`/`hash` match
 * the DOM `Location` shape (search keeps its `?`, hash its `#`). */
export interface BlockerLocation {
  readonly pathname: string
  readonly search: string
  readonly hash: string
}

/**
 * Decide whether a navigation should be halted. Receives where the app is (`currentLocation`) and where
 * it's heading (`nextLocation`), so a guard can allow same-section moves and block only real exits. A
 * boolean form (`useBlocker(isDirty)`) is sugar for `() => isDirty`. Runs synchronously at navigation
 * time - return the current answer; the async "are you sure?" happens afterward via {@link Blocker}'s
 * `proceed`/`reset`.
 */
export type BlockerFunction = (args: {
  readonly currentLocation: BlockerLocation
  readonly nextLocation: BlockerLocation
}) => boolean

/**
 * The blocker's lifecycle. `unblocked` - idle, nothing intercepted. `blocked` - a navigation was halted
 * and is awaiting the app's decision (`proceed`/`reset` are live). `proceeding` - the app called
 * `proceed`; the held navigation is being replayed.
 */
export type BlockerState = "unblocked" | "blocked" | "proceeding"

/**
 * A navigation guard, mirroring react-router's shape. When `state` is `blocked`, `proceed()` lets the
 * held navigation through and `reset()` cancels it (staying put); both are `undefined` otherwise. The
 * pair is what a boolean `when` can't express - the app shows its OWN async confirmation UI, then calls
 * one of them, instead of the browser's synchronous `confirm()`.
 */
export interface Blocker {
  readonly state: BlockerState
  readonly proceed: (() => void) | undefined
  readonly reset: (() => void) | undefined
}

/** The idle blocker - a stable reference (no needless adapter re-renders while unblocked). */
export const IDLE_BLOCKER: Blocker = { state: "unblocked", proceed: undefined, reset: undefined }

/**
 * The browser layer's blocker registry - installed by `installHistory` (which owns navigation and can
 * therefore halt, restore, and replay it) and read by an adapter's `useBlocker` through
 * {@link registerBlocker}. Kept here, DOM-free, for the same reason as {@link BrowserNavigate}: a route
 * component's blocker hook must import only this agnostic entry.
 */
export interface BlockerController {
  register(shouldBlock: BlockerFunction, onChange: (blocker: Blocker) => void): () => void
}

// The active controller (set by `installHistory`, cleared on teardown). Module-scoped: one app per page.
let blockerController: BlockerController | undefined

/** Register (or clear, with `undefined`) the blocker controller - called by `installHistory`. Not for
 * app use. */
export function setBlockerController(controller: BlockerController | undefined): void {
  blockerController = controller
}

/**
 * Register a navigation guard, returning an unregister function. `onChange` is called with the current
 * {@link Blocker} whenever its state changes (so the adapter can re-render its confirmation UI). Before
 * `installHistory` has run (SSR, pre-hydration), there's no controller: registration is a no-op and the
 * caller stays on {@link IDLE_BLOCKER}, degrading to native navigation. Called by an adapter's
 * `useBlocker`, not by app code directly.
 */
export function registerBlocker(
  shouldBlock: BlockerFunction,
  onChange: (blocker: Blocker) => void,
): () => void {
  return blockerController?.register(shouldBlock, onChange) ?? (() => {})
}

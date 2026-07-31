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

/** Options for a programmatic navigation. */
export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one (like `history.replaceState`). */
  readonly replace?: boolean
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

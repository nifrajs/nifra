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

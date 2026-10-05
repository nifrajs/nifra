/**
 * `@nifrajs/web/client` - the agnostic browser layer for client-side navigation. It wires the pure
 * router store ({@link ClientRouter}) to the browser: `pushState` on navigate, `popstate` →
 * navigate, and delegated interception of same-origin `<a>` clicks (client transition instead of
 * a full page load). DOM-only - never imported on the server, so the store stays SSR-safe.
 */
import { trustedHeadAttributes } from "./internal/head-attributes.ts"
import { EXECUTABLE_SCRIPT_TYPES, INERT_SCRIPT_TYPES } from "./internal/script-types.ts"
import type { Meta } from "./manifest.ts"
import {
  type Blocker,
  type BlockerController,
  type BlockerFunction,
  type BlockerLocation,
  type BlockerState,
  type BrowserNavigate,
  IDLE_BLOCKER,
  setBlockerController,
  setBrowserNavigate,
} from "./navigation.ts"
import { type ClientRouter, redirectOf } from "./router.ts"

/** Read the nonce carried by the current server-rendered document, if any. */
export function currentDocumentNonce(): string | undefined {
  if (typeof document === "undefined") return undefined
  const documentLike = document as unknown as {
    querySelector?: (selector: string) => Element | null
  }
  const script = documentLike.querySelector?.("script[nonce]")
  if (script === null || script === undefined) return undefined
  const property = (script as Element & { readonly nonce?: unknown }).nonce
  if (typeof property === "string" && property !== "") return property
  return script.getAttribute("nonce") ?? undefined
}

/**
 * Everything the generated client entry needs, re-exported here so that entry imports ONE module and
 * that module is DOM-only. It used to take these from `@nifrajs/web`, whose graph includes `renderPage`
 * and the static-file server: bundled builds tree-shook the server half away, but Vite's dev server
 * serves modules as written, so the browser evaluated `public-dir.ts` and died on `node:fs/promises`
 * before hydrating. The fix is for the entry not to name the server module in the first place.
 */
export { mergeHeads, resolveMeta } from "./internal/head-merge.ts"
export {
  getBrowserNavigate,
  IDLE_BLOCKER,
  registerBlocker,
  resolveNavigate,
} from "./navigation.ts"
export { createMutation, createQueryClient } from "./query.ts"
export { createClientRouter, createMatcher } from "./router.ts"
// Same reason, for the ADAPTER packages (`@nifrajs/web-react` and friends). Every one of them reaches
// for these from the root - `searchOfChain` in its `/client` entry, the navigation and query values in
// its router/query modules - and every one of those modules is in the browser graph. They are defined
// in DOM-safe modules already; the only thing wrong was the specifier they were imported through.
export { searchOf, searchOfChain } from "./search.ts"
// Types are deliberately NOT re-exported here. `RouteSearch` is augmented by generated code through
// `declare module "@nifrajs/web"`, and an interface augmentation lands on the module it names - so a
// type taken from this path would be the un-augmented one and typed `navigate({ to, search })` would
// silently go loose. Adapters keep sourcing types from the root; what they must avoid is the
// `export type { X } from "@nifrajs/web"` FORM, which leaves a bare `import "@nifrajs/web"` behind for
// its side effects. `import type` + a local `export type` erases completely.

export interface InstallHistoryOptions {
  /** Full-page fallback when a client navigation can't proceed (default: `location.assign`). */
  readonly fallback?: (path: string) => void
}

/** Options for {@link waitForStyles}. */
export interface WaitForStylesOptions {
  /**
   * Maximum time to wait for one framework-owned deferred stylesheet before hydrating anyway.
   * Defaults to 4000 ms and is capped at 30000 ms so a bad value cannot leave the app inert forever.
   */
  readonly timeoutMs?: number
}

const DEFAULT_CSS_WAIT_MS = 4_000
const MAX_CSS_WAIT_MS = 30_000
type CssLinkState = "loaded" | "error" | "timeout"

// Per-link promises keep repeated calls idempotent without retaining an entire document after a hard
// navigation. A WeakMap also lets tests and embedded documents replace `globalThis.document` safely.
const stylesheetWaits = new WeakMap<HTMLLinkElement, Promise<void>>()

const cssLinkStateOf = (link: HTMLLinkElement): CssLinkState | undefined => {
  const state = link.getAttribute("data-nifra-css-state")
  return state === "loaded" || state === "error" || state === "timeout" ? state : undefined
}

const hasLoadedStylesheet = (link: HTMLLinkElement): boolean => {
  // Accessing `sheet` is safe for cross-origin stylesheets, but a browser may still throw while it is
  // tearing down a document. Treat that as "not observed yet"; the load/error listener or the bounded
  // timer is the authoritative fallback.
  try {
    return link.sheet !== null
  } catch {
    return false
  }
}

const stylesheetLabel = (link: HTMLLinkElement): string =>
  link.getAttribute("href") ?? link.href ?? "<unknown>"

/**
 * Wait for one server-emitted deferred stylesheet. The promise ALWAYS settles: a failed or slow CSS
 * request must not leave the server-rendered page's loader visible forever. `media="all"` is applied on
 * every terminal state so a late network completion cannot leave a link permanently in print media.
 */
const waitForStylesheet = (link: HTMLLinkElement, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      link.removeEventListener("load", onLoad)
      link.removeEventListener("error", onError)
      if (timer !== undefined) clearTimeout(timer)
    }
    const finish = (state: CssLinkState): void => {
      if (settled) return
      settled = true
      cleanup()
      link.setAttribute("data-nifra-css-state", state)
      // Only the coordinator promotes the framework-owned link, after the resource has settled.
      link.media = "all"
      resolve()
    }
    const onLoad = (): void => finish("loaded")
    const onError = (): void => {
      console.error(`[nifra/web] stylesheet failed to load: ${stylesheetLabel(link)}`)
      finish("error")
    }

    const prior = cssLinkStateOf(link)
    if (prior !== undefined) {
      finish(prior)
      return
    }
    if (hasLoadedStylesheet(link)) {
      finish("loaded")
      return
    }

    // Attach listeners before the second loaded-sheet check: a cached resource can transition between
    // the first check and listener registration, and the second check closes that small race.
    link.addEventListener("load", onLoad, { once: true })
    link.addEventListener("error", onError, { once: true })
    timer = setTimeout(() => {
      console.warn(
        `[nifra/web] stylesheet load timed out after ${timeoutMs}ms: ${stylesheetLabel(link)}`,
      )
      finish("timeout")
    }, timeoutMs)
    if (hasLoadedStylesheet(link)) finish("loaded")
  })

const validateCssWaitMs = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `[nifra/web] css wait timeout must be a finite positive number, received ${value}`,
    )
  }
  return Math.min(value, MAX_CSS_WAIT_MS)
}

/**
 * Wait for the framework-owned deferred stylesheet links in the initial document, then promote them to
 * `media="all"`. It is safe to call more than once: repeated calls for one document share the same
 * per-link waits, and duplicate framework links are removed before waiting. Blocking links are not
 * touched.
 *
 * This function lives in the browser-only `@nifrajs/web/client` entry. It is nevertheless defensive
 * when imported in a non-DOM environment so an accidental import cannot crash a server process.
 */
export function waitForStyles(options: WaitForStylesOptions = {}): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve()
  const timeoutMs = validateCssWaitMs(options.timeoutMs ?? DEFAULT_CSS_WAIT_MS)
  const links = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[data-nifra-css="deferred"]'),
  ).filter(
    (link) =>
      link.getAttribute("data-nifra-css") === "deferred" && link.rel.toLowerCase() === "stylesheet",
  )
  const unique: HTMLLinkElement[] = []
  const seen = new Set<string>()
  for (const link of links) {
    const key = stylesheetLabel(link)
    if (seen.has(key)) {
      // Only remove a duplicate carrying the framework marker; author-owned links are outside this
      // selector and cannot be affected. Keeping the first link preserves its event state and cache.
      link.remove()
      continue
    }
    seen.add(key)
    unique.push(link)
  }
  if (unique.length === 0) return Promise.resolve()
  const promises = unique.map((link) => {
    const existing = stylesheetWaits.get(link)
    if (existing !== undefined) return existing
    const promise = waitForStylesheet(link, timeoutMs)
    stylesheetWaits.set(link, promise)
    return promise
  })
  return Promise.all(promises).then(() => undefined)
}

/**
 * Resolve `href` against this page and keep it only when history may move there without a load: same
 * scheme and host as the document, or null. Compared by protocol + host rather than `URL.origin`,
 * which is `"null"` for every non-special scheme - a native webview's `capacitor://localhost` page and
 * a `javascript:` target alike. An opaque or `file:` document may not push another path at all, so its
 * links load natively.
 */
function sameDocumentUrl(href: string): URL | null {
  if (location.origin === "null" || location.protocol === "file:") return null
  try {
    const url = new URL(href, location.href)
    return url.protocol === location.protocol && url.host === location.host ? url : null
  } catch {
    return null
  }
}

/**
 * Attach history + link interception to a router. Returns a teardown function that removes the
 * listeners. A data-fetch failure during a client navigation falls back to a full-page load, so
 * navigation degrades gracefully rather than leaving the user stuck.
 */
export function installHistory(
  router: ClientRouter,
  options: InstallHistoryOptions = {},
): () => void {
  const fallback = options.fallback ?? ((path: string) => location.assign(path))

  // We manage scroll ourselves (save per history entry, restore after the navigated content
  // renders), so disable the browser's native restoration which would otherwise fight us.
  history.scrollRestoration = "manual"
  // A pending scroll is either a saved [x,y] (fresh push → top; back/forward → the stored position) or a
  // fragment target (`#id`) to scroll to once the cross-page navigation's content renders.
  type PendingScroll = { readonly pos: readonly [number, number] } | { readonly hash: string }
  let pendingScroll: PendingScroll | null = null

  // Navigation-guard state (useBlocker). `index` is our position in the history line, stored in
  // `history.state.nifraIndex`; it exists solely to reverse a blocked back/forward (a popstate can't be
  // cancelled, so we read the delta from the index and `history.go(-delta)` back). `here` is the location
  // we're currently on - after a popstate `location` is already the destination, so "where we were" has
  // to be tracked, not read. `reversing` swallows the popstate our own restoring `history.go` fires.
  let index = (history.state as { nifraIndex?: number } | null)?.nifraIndex ?? 0
  let here = location.pathname + location.search + (location.hash ?? "")
  let reversing = false
  // The path the router was last seen loading, so a redirect it follows shows up as a change.
  let expected: string | undefined
  type Registration = {
    readonly shouldBlock: BlockerFunction
    readonly emit: (blocker: Blocker) => void
    state: BlockerState
  }
  // A single active guard (like react-router, one blocker at a time); the latest registration wins.
  let registration: Registration | undefined
  const scrollOf = (state: unknown): [number, number] => {
    const saved = (state as { nifraScroll?: [number, number] } | null)?.nifraScroll
    return Array.isArray(saved) ? saved : [0, 0]
  }
  // The fragment id from a `#hash` (percent-decoded; a malformed escape falls back to the raw value).
  const hashId = (hash: string): string => {
    const raw = hash.slice(1)
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  // Resolve a fragment id to its element by `id`, or null if absent.
  const findAnchor = (id: string): Element | null => {
    if (id === "") return null
    return document.getElementById(id)
  }

  // Wrap a navigation's render in a View Transition when the browser supports it - a graceful
  // enhancement (no-op elsewhere). The captured "before" is held across the data fetch, so pair
  // with link prefetch (hover/focus warms the cache) to keep most transitions instant.
  type ViewTransition = {
    readonly ready: Promise<unknown>
    readonly finished: Promise<unknown>
    readonly updateCallbackDone: Promise<unknown>
  }
  type ViewTransitionDocument = Document & {
    startViewTransition?: (cb: () => unknown) => ViewTransition
  }
  const transition = (run: () => Promise<void>): void => {
    const doc = document as ViewTransitionDocument
    if (typeof doc.startViewTransition !== "function") {
      void run()
      return
    }
    const vt = doc.startViewTransition(run)
    // Rapid in-app clicks supersede an in-flight transition; the browser skips it and rejects its
    // promises. Reasons vary by engine - InvalidStateError "Transition was aborted because of
    // invalid state", or AbortError "Transition was skipped". The navigation still completes, so
    // we swallow these expected aborts rather than let them surface as unhandled rejections.
    for (const p of [vt.ready, vt.finished, vt.updateCallbackDone]) p.catch(() => {})
  }

  // Parse a path into the `{ pathname, search, hash }` a `BlockerFunction` decides on.
  const locationOf = (path: string): BlockerLocation => {
    const url = new URL(path, location.href)
    return { pathname: url.pathname, search: url.search, hash: url.hash }
  }

  // The single funnel every navigation asks before it commits. Returns true (navigation held) when a
  // guard is armed and blocks; false when it may proceed. `retry` performs the navigation and is what
  // `proceed` replays. While a prompt is already open (`blocked`) further navigations are swallowed; the
  // replay from `proceed` (`proceeding`) is let straight through.
  const guard = (nextPath: string, retry: () => void): boolean => {
    const reg = registration
    if (reg === undefined || reg.state === "proceeding") return false
    if (reg.state === "blocked") return true
    if (!reg.shouldBlock({ currentLocation: locationOf(here), nextLocation: locationOf(nextPath) }))
      return false
    reg.state = "blocked"
    reg.emit({
      state: "blocked",
      proceed: () => {
        if (reg.state !== "blocked") return
        reg.state = "proceeding"
        reg.emit({ state: "proceeding", proceed: undefined, reset: undefined })
        retry()
      },
      reset: () => {
        if (reg.state !== "blocked") return
        reg.state = "unblocked"
        reg.emit(IDLE_BLOCKER)
      },
    })
    return true
  }

  // Once a proceeded navigation has committed, return the guard to idle so it can block the next one.
  const settle = (): void => {
    const reg = registration
    if (reg !== undefined && reg.state === "proceeding") {
      reg.state = "unblocked"
      reg.emit(IDLE_BLOCKER)
    }
  }

  // Commit a navigation only after its URL and origin are known-safe. An unmatched same-origin path
  // becomes a hard load BEFORE history is mutated; otherwise the address bar could change while the
  // router intentionally kept rendering the old route.
  const commit = (path: string, url: URL, mode: "push" | "replace", state?: unknown): void => {
    const routePath = url.pathname + url.search
    if (router.match(routePath) === null) {
      settle()
      fallback(path)
      return
    }
    // Caller-supplied entry state rides along under its own key (`nifraState`), so it can never
    // collide with the router's bookkeeping (`nifraIndex`/`nifraScroll`); the browser restores the
    // whole object on back/forward for free.
    const entryState =
      state !== undefined ? { nifraIndex: index, nifraState: state } : { nifraIndex: index }
    if (mode === "replace") {
      // Replace the current entry (same index) with the new URL. The entry we're leaving is discarded, so
      // its scroll isn't worth saving; the new route scrolls to its fragment target, else the top.
      history.replaceState(entryState, "", path)
      pendingScroll = url.hash !== "" ? { hash: hashId(url.hash) } : { pos: [0, 0] }
    } else {
      // Save the leaving entry's scroll (spread keeps its nifraIndex), push a fresh higher-indexed entry
      // (URL incl. any #hash), then scroll the new route: to the fragment target if given, else the top.
      history.replaceState({ ...(history.state ?? {}), nifraScroll: [scrollX, scrollY] }, "")
      index += 1
      entryState.nifraIndex = index
      history.pushState(entryState, "", path)
      pendingScroll = url.hash !== "" ? { hash: hashId(url.hash) } : { pos: [0, 0] }
    }
    here = url.pathname + url.search + url.hash
    expected = routePath
    // The data layer fetches by path+search; the #hash is client-only (never sent to the server).
    transition(() => router.navigate(routePath).catch((error) => leave(error, path)))
    settle()
  }

  // A redirect out of the app replaces the entry it answered, as the browser's own redirect would; any
  // other failure loads the page as a document.
  const leave = (error: unknown, path: string): void => {
    const to = redirectOf(error)
    if (to === undefined) fallback(path)
    else location.replace(to)
  }

  const go = (path: string, mode: "push" | "replace", state?: unknown): void => {
    // Validate before the blocker observes the target. A blocker receives parsed locations, so letting a
    // malformed string reach `locationOf` would make an otherwise no-throw navigate unexpectedly throw.
    const url = sameDocumentUrl(path)
    if (url === null) {
      settle()
      return
    }
    if (guard(path, () => commit(path, url, mode, state))) return
    commit(path, url, mode, state)
  }

  // Programmatic navigation for adapter `useNavigate` bindings, published through the DOM-free bridge
  // (`@nifrajs/web`'s `getBrowserNavigate`). A string path pushes (or replaces); a number is a history
  // delta (`-1` back / `1` forward), matching `history.go`. Off-route same-origin destinations hard-load
  // without first creating a stale in-document history entry. Cross-origin and active-scheme strings are
  // rejected; callers that intentionally leave the app use a normal `<a>`.
  const navigate: BrowserNavigate = (to, navOptions) => {
    if (typeof to === "number") {
      history.go(to)
      return
    }
    go(to, navOptions?.replace === true ? "replace" : "push", navOptions?.state)
  }
  setBrowserNavigate(navigate, router)

  // Publish the guard registry through the DOM-free bridge (`@nifrajs/web`'s `registerBlocker`, which an
  // adapter's `useBlocker` calls). One slot, latest registration wins; the unregister clears it only if
  // it's still the current one (so a stale unmount doesn't wipe a newer guard).
  const controller: BlockerController = {
    register(shouldBlock, onChange) {
      const reg: Registration = { shouldBlock, emit: onChange, state: "unblocked" }
      registration = reg
      return () => {
        if (registration === reg) registration = undefined
      }
    },
  }
  setBlockerController(controller)

  // Resolve an event target to an in-app route path, or null (cross-origin, unknown route, or an
  // anchor opting out via target/download/rel=external). Shared by click + hover/focus prefetch.
  const inAppHref = (target: EventTarget | null): string | null => {
    const anchor = target instanceof Element ? target.closest("a") : null
    if (anchor === null) return null
    if (anchor.target !== "" && anchor.target !== "_self") return null
    if (anchor.hasAttribute("download")) return null
    if (anchor.getAttribute("rel")?.split(/\s+/).includes("external")) return null
    const url = sameDocumentUrl(anchor.href)
    if (url === null) return null
    if (router.match(url.pathname) === null) return null
    // A same-page fragment link (`#section`, `/here#section` - only the hash differs) → null: let the
    // browser do its native in-page anchor jump. Intercepting it would drop the fragment from the URL
    // and force a scroll-to-top (a fresh push restores [0,0]) - i.e. break every in-page anchor (AUDIT
    // H2). (A same-page link with NO hash still soft-navigates, as before.)
    if (url.pathname === location.pathname && url.search === location.search && url.hash !== "")
      return null
    // Keep the hash: a cross-page link to `/docs#install` lands on that anchor once the page renders.
    return url.pathname + url.search + url.hash
  }

  const onClick = (event: MouseEvent): void => {
    // Let the browser handle anything that isn't a plain left-click (modifiers = new tab/window).
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const href = inAppHref(event.target)
    if (href === null) return
    event.preventDefault()
    go(href, "push")
  }

  // `data-nifra-prefetch` on a link or any ancestor (the nearest wins) says when the link warms its
  // route's chunk and data: `intent` (the default) on hover or focus, `viewport` once it scrolls into
  // view, `render` as soon as a page shows it, `none` never.
  const prefetchModeOf = (el: Element): string | undefined =>
    (el.closest("[data-nifra-prefetch]") as HTMLElement | null)?.dataset.nifraPrefetch

  // Warm an in-app link's route (the store dedupes the spam). The page on screen has nothing to warm.
  const warm = (target: EventTarget | null): void => {
    const href = inAppHref(target)
    if (href === null) return
    const url = new URL(href, location.href)
    const path = url.pathname + url.search // the #hash isn't data
    if (path !== location.pathname + location.search) void router.prefetch(path)
  }

  const onPrefetch = (event: Event): void => {
    const target = event.target
    if (target instanceof Element && prefetchModeOf(target) !== "none") warm(target)
  }

  // `viewport` and `render` links are looked for when history is installed (the server-rendered page)
  // and whenever the router settles (a navigation, a submit's revalidation). A link the page adds in
  // between warms on intent until the next settle.
  let inView: IntersectionObserver | undefined
  const scan = (): void => {
    inView?.disconnect()
    for (const anchor of document.querySelectorAll(
      "a[data-nifra-prefetch],[data-nifra-prefetch] a",
    )) {
      const mode = prefetchModeOf(anchor)
      if (mode === "render") warm(anchor)
      else if (mode === "viewport") {
        // Scrolling back into view asks again; the store holds a fresh prefetch, so nothing refetches.
        inView ??= new IntersectionObserver((entries) => {
          for (const entry of entries) if (entry.isIntersecting) warm(entry.target)
        })
        inView.observe(anchor)
      }
    }
  }

  // Back/forward: the entry already exists (no push). The URL has ALSO already changed - a popstate can't
  // be cancelled - so a guard here can only restore-then-prompt: read the delta from our index, and if the
  // guard holds, `history.go(-delta)` back to where we were (ignoring the popstate that reversal fires via
  // `reversing`) while `proceed` re-issues `history.go(delta)` to redo the move. Unguarded, it's the old
  // path: restore the entry's saved scroll after it renders.
  const onPopState = (): void => {
    if (reversing) {
      reversing = false
      return
    }
    const newIndex = (history.state as { nifraIndex?: number } | null)?.nifraIndex ?? 0
    const dest = location.pathname + location.search + (location.hash ?? "")
    const delta = newIndex - index
    if (guard(dest, () => history.go(delta))) {
      reversing = true
      history.go(-delta)
      return
    }
    index = newIndex
    here = dest
    pendingScroll = { pos: scrollOf(history.state) }
    const routePath = location.pathname + location.search
    expected = routePath
    transition(() => router.navigate(routePath).catch((error) => leave(error, dest)))
    settle()
  }

  // Close / reload / hard navigation away: no in-app destination exists, so consult the guard with the
  // current location as both sides. A dirtiness guard (a boolean, or one that checks its own state) then
  // triggers the browser's native "Leave site?" prompt; a purely destination-based guard won't. Browsers
  // ignore any custom message - the string is set only because legacy engines require `returnValue`.
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    const reg = registration
    if (reg === undefined || reg.state === "proceeding") return
    // `blocked` already proves the guard found unsaved state. Re-check only while idle; suppressing the
    // native prompt merely because an in-app confirmation is open creates a close/reload data-loss gap.
    if (
      reg.state === "unblocked" &&
      !reg.shouldBlock({ currentLocation: locationOf(here), nextLocation: locationOf(here) })
    )
      return
    event.preventDefault()
    event.returnValue = ""
  }

  // The router is loading a page the address bar does not show: a redirect it follows. That replaces the
  // entry a navigation pushed, or adds one after a form post, as the browser would. A redirect from a
  // form post back to the page it was on adds nothing.
  const follow = (path: string): void => {
    if (path !== location.pathname + location.search) {
      if (expected === undefined) {
        history.replaceState({ ...(history.state ?? {}), nifraScroll: [scrollX, scrollY] }, "")
        index += 1
        history.pushState({ nifraIndex: index }, "", path)
      } else {
        history.replaceState(history.state, "", path + location.hash)
      }
      here = location.pathname + location.search + location.hash
      pendingScroll = location.hash !== "" ? { hash: hashId(location.hash) } : { pos: [0, 0] }
    }
    expected = path
  }

  // After a navigation settles (content rendered), apply the pending scroll target on the next frame:
  // a fragment's element for a cross-page `#hash`, the saved position for back/forward, else the top.
  // A settle with no navigation (a submit's revalidation) scrolls nothing. Either way the rendered
  // page is then scanned for links to warm.
  const settled = (): void => {
    const { pending, pendingPath } = router.snapshot()
    if (pending) {
      if (pendingPath !== undefined && pendingPath !== expected) follow(pendingPath)
      return
    }
    expected = undefined
    const target = pendingScroll
    pendingScroll = null
    requestAnimationFrame(() => {
      if (target !== null && "hash" in target) {
        const el = findAnchor(target.hash)
        if (el !== null) el.scrollIntoView()
        else window.scrollTo(0, 0) // fragment not found → top, like a fresh page load
      } else if (target !== null) {
        window.scrollTo(target.pos[0], target.pos[1])
      }
      scan()
    })
  }
  const unsubscribe = router.subscribe(settled)
  scan()

  document.addEventListener("click", onClick)
  document.addEventListener("pointerover", onPrefetch)
  document.addEventListener("focusin", onPrefetch)
  window.addEventListener("popstate", onPopState)
  window.addEventListener("beforeunload", onBeforeUnload)
  return () => {
    unsubscribe()
    inView?.disconnect()
    setBrowserNavigate(undefined) // stop routing `useNavigate` to a torn-down router
    setBlockerController(undefined) // stop routing `useBlocker` to a torn-down registry
    document.removeEventListener("click", onClick)
    document.removeEventListener("pointerover", onPrefetch)
    document.removeEventListener("focusin", onPrefetch)
    window.removeEventListener("popstate", onPopState)
    window.removeEventListener("beforeunload", onBeforeUnload)
  }
}

/**
 * Intercept submissions of same-origin `<form method="post">` whose action targets an app route:
 * submit via the router (no full reload - POST the action, then revalidate the active loader). On
 * failure it falls back to a native submit, so the form still works. Returns a teardown function.
 */
/**
 * Sync the document head to a route's resolved {@link Meta} on client navigation. Sets the title
 * (when provided) and replaces the **managed** (`data-nifra`) `<meta>`/`<link>` tags - static head
 * content (charset, hand-written tags) is never touched. SSR injects the same `data-nifra` tags, so
 * the first navigation cleanly takes over from the server-rendered head.
 */
export function applyHead(head: Meta): void {
  const documentNonce = currentDocumentNonce()
  if (head.title !== undefined) document.title = head.title
  // `<html lang>`/`<html dir>` - applied AUTHORITATIVELY (unlike `title`, which is left alone when the
  // route omits it), mirroring the SSR shell's defaulting exactly: `lang` falls back to `"en"`, `dir` is
  // removed when unset. Anything laxer drifts on a multilingual site - navigating /ur → /en would leave
  // `dir="rtl"` behind and lay the English page out right-to-left, a bug a hard reload would not show.
  const root = document.documentElement
  root.setAttribute("lang", head.lang ?? "en")
  if (head.dir === undefined) root.removeAttribute("dir")
  else root.setAttribute("dir", head.dir)
  for (const el of document.head.querySelectorAll("[data-nifra]")) el.remove()
  // Values follow the same HTML attribute conventions as the SSR `tagAttrs`: a string sets the value,
  // `true` sets the bare boolean attribute, `false`/`undefined` skip it - so a soft-nav head matches
  // the server-rendered one exactly (no hydration drift on the managed tags).
  const add = (tag: "meta" | "link", attrs: Readonly<object>): void => {
    const trusted = trustedHeadAttributes(tag, attrs)
    if (trusted === null) return
    const el = document.createElement(tag)
    for (const [name, value] of trusted) {
      el.setAttribute(name, value === true ? "" : value)
    }
    el.setAttribute("data-nifra", "")
    document.head.appendChild(el)
  }
  for (const m of head.meta ?? []) add("meta", m)
  for (const l of head.link ?? []) add("link", l)
  // `<script>` slot (JSON-LD etc.) - soft-nav parity with the SSR `headTags` script render. Set the body
  // via `textContent`, NOT `innerHTML`: `textContent` assigns the raw string without HTML re-parsing, so
  // a `</script>` (or `<!--`/`]]>`) payload in the JSON-LD can't break out - the DOM-native equivalent of
  // the server's `escapeScriptContent`. `type` defaults to `application/ld+json` (matching the SSR side).
  for (const s of head.script ?? []) {
    const type = s.type ?? "application/ld+json"
    if (!INERT_SCRIPT_TYPES.has(type)) {
      throw new TypeError("[nifra/web] refusing executable content in the inert head.script slot")
    }
    const el = document.createElement("script")
    el.setAttribute("type", type)
    el.textContent = s.content
    el.setAttribute("data-nifra", "")
    document.head.appendChild(el)
  }
  for (const s of head.unsafeScript ?? []) {
    if (s.unsafe !== true || s.nonce.trim() === "") {
      throw new TypeError("[nifra/web] executable inline scripts require a non-empty CSP nonce")
    }
    // Same allowlist the server applies. `setAttribute` cannot be broken out of the way the server's
    // template literal could, so this is not about injection here - it is about the two halves
    // accepting the same documents, so a head that renders cannot fail on the next soft-nav.
    if (!EXECUTABLE_SCRIPT_TYPES.has(s.type)) {
      throw new TypeError(
        `[nifra/web] unsupported executable script type ${JSON.stringify(s.type)}`,
      )
    }
    if (documentNonce !== undefined && s.nonce !== documentNonce) {
      throw new TypeError(
        "[nifra/web] executable head scripts must use the same CSP nonce as the document",
      )
    }
    const el = document.createElement("script")
    el.setAttribute("type", s.type)
    el.setAttribute("nonce", s.nonce)
    el.textContent = s.content
    el.setAttribute("data-nifra", "")
    document.head.appendChild(el)
  }
}

export function installForms(router: ClientRouter): () => void {
  const onSubmit = (event: SubmitEvent): void => {
    if (event.defaultPrevented) return
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    if (form.method.toLowerCase() !== "post") return // GET forms submit natively
    const url = sameDocumentUrl(form.action) // resolved (or the current document URL if unset)
    if (url === null) return
    if (router.match(url.pathname) === null) return // not an app route → native submit
    event.preventDefault()
    // `data-nifra-revalidate="false"` opts out of the post-action loader revalidation (the action's
    // actionData drives the update); absent or any other value keeps the default revalidation.
    const revalidate = form.dataset.nifraRevalidate !== "false"
    router.submit(url.pathname + url.search, new FormData(form), { revalidate }).catch((error) => {
      const to = redirectOf(error)
      // The action ran: load the page that shows its result rather than run it again.
      if (to !== undefined) location.assign(to)
      else form.submit() // data submit failed - fall back to a full-page POST
    })
  }
  document.addEventListener("submit", onSubmit)
  return () => document.removeEventListener("submit", onSubmit)
}

/**
 * Mark the document interactive once the client has hydrated: sets `data-nifra-hydrated` on `<html>`
 * and fires a one-shot `nifra:hydrated` event. The generated client entry calls this on the next frame
 * after the adapter mounts (so every framework binding gets it), letting apps gate a custom JS-only
 * interaction that would otherwise fire before its handler is attached. Idempotent. nifra's own
 * progressive-enhancement forms/links don't need it - only hand-wired onClick/onSubmit handlers with no
 * native fallback do. See the Hydration guide.
 */
export function signalHydrated(): void {
  const el = document.documentElement
  if (el.hasAttribute("data-nifra-hydrated")) return
  el.setAttribute("data-nifra-hydrated", "")
  document.dispatchEvent(new Event("nifra:hydrated"))
}

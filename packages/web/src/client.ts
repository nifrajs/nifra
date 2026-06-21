/**
 * `@nifrajs/web/client` — the agnostic browser layer for client-side navigation. It wires the pure
 * router store ({@link ClientRouter}) to the browser: `pushState` on navigate, `popstate` →
 * navigate, and delegated interception of same-origin `<a>` clicks (client transition instead of
 * a full page load). DOM-only — never imported on the server, so the store stays SSR-safe.
 */
import type { Meta } from "./manifest.ts"
import type { ClientRouter } from "./router.ts"

export interface InstallHistoryOptions {
  /** Full-page fallback when a client navigation can't proceed (default: `location.assign`). */
  readonly fallback?: (path: string) => void
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
  // Resolve a fragment id to its element — by `id`, then a legacy `<a name>` — or null if absent.
  const findAnchor = (id: string): Element | null => {
    if (id === "") return null
    const byId = document.getElementById(id)
    if (byId !== null) return byId
    try {
      return document.querySelector(`a[name="${CSS.escape(id)}"]`)
    } catch {
      return null // CSS/CSS.escape unavailable or an exotic id → no named-anchor match
    }
  }

  // Wrap a navigation's render in a View Transition when the browser supports it — a graceful
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
    // promises. Reasons vary by engine — InvalidStateError "Transition was aborted because of
    // invalid state", or AbortError "Transition was skipped". The navigation still completes, so
    // we swallow these expected aborts rather than let them surface as unhandled rejections.
    for (const p of [vt.ready, vt.finished, vt.updateCallbackDone]) p.catch(() => {})
  }

  const go = (path: string, push: boolean): void => {
    const url = new URL(path, location.origin)
    if (push) {
      // Save the leaving entry's scroll, push a fresh entry (URL incl. any #hash), then scroll the new
      // route: to the fragment target if one was given, else to the top.
      history.replaceState({ ...(history.state ?? {}), nifraScroll: [scrollX, scrollY] }, "")
      history.pushState({}, "", path)
      pendingScroll = url.hash !== "" ? { hash: hashId(url.hash) } : { pos: [0, 0] }
    }
    // The data layer fetches by path+search; the #hash is client-only (never sent to the server).
    transition(() => router.navigate(url.pathname + url.search).catch(() => fallback(path)))
  }

  // Resolve an event target to an in-app route path, or null (cross-origin, unknown route, or an
  // anchor opting out via target/download/rel=external). Shared by click + hover/focus prefetch.
  const inAppHref = (target: EventTarget | null): string | null => {
    const anchor = target instanceof Element ? target.closest("a") : null
    if (anchor === null) return null
    if (anchor.target !== "" && anchor.target !== "_self") return null
    if (anchor.hasAttribute("download")) return null
    if (anchor.getAttribute("rel")?.split(/\s+/).includes("external")) return null
    const url = new URL(anchor.href)
    if (url.origin !== location.origin) return null
    if (router.match(url.pathname) === null) return null
    // A same-page fragment link (`#section`, `/here#section` — only the hash differs) → null: let the
    // browser do its native in-page anchor jump. Intercepting it would drop the fragment from the URL
    // and force a scroll-to-top (a fresh push restores [0,0]) — i.e. break every in-page anchor (AUDIT
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
    go(href, true)
  }

  // Hover/focus an in-app link → warm its chunk + data (the store dedupes the spam).
  const onPrefetch = (event: Event): void => {
    const href = inAppHref(event.target)
    if (href === null) return
    const url = new URL(href, location.origin)
    void router.prefetch(url.pathname + url.search) // warm by path+search; the #hash isn't data
  }

  // Back/forward: the entry exists (no push); restore its saved scroll after it renders.
  const onPopState = (): void => {
    pendingScroll = { pos: scrollOf(history.state) }
    transition(() =>
      router.navigate(location.pathname + location.search).catch(() => fallback(location.pathname)),
    )
  }

  // After a navigation settles (content rendered), apply the pending scroll target on the next frame:
  // a fragment's element for a cross-page `#hash`, the saved position for back/forward, else the top.
  // Skipped for submits (pending).
  const restoreScroll = (): void => {
    if (router.snapshot().pending || pendingScroll === null) return
    const target = pendingScroll
    pendingScroll = null
    requestAnimationFrame(() => {
      if ("hash" in target) {
        const el = findAnchor(target.hash)
        if (el !== null) el.scrollIntoView()
        else window.scrollTo(0, 0) // fragment not found → top, like a fresh page load
      } else {
        window.scrollTo(target.pos[0], target.pos[1])
      }
    })
  }
  const unsubscribe = router.subscribe(restoreScroll)

  document.addEventListener("click", onClick)
  document.addEventListener("pointerover", onPrefetch)
  document.addEventListener("focusin", onPrefetch)
  window.addEventListener("popstate", onPopState)
  return () => {
    unsubscribe()
    document.removeEventListener("click", onClick)
    document.removeEventListener("pointerover", onPrefetch)
    document.removeEventListener("focusin", onPrefetch)
    window.removeEventListener("popstate", onPopState)
  }
}

/**
 * Intercept submissions of same-origin `<form method="post">` whose action targets an app route:
 * submit via the router (no full reload — POST the action, then revalidate the active loader). On
 * failure it falls back to a native submit, so the form still works. Returns a teardown function.
 */
/**
 * Sync the document head to a route's resolved {@link Meta} on client navigation. Sets the title
 * (when provided) and replaces the **managed** (`data-nifra`) `<meta>`/`<link>` tags — static head
 * content (charset, hand-written tags) is never touched. SSR injects the same `data-nifra` tags, so
 * the first navigation cleanly takes over from the server-rendered head.
 */
export function applyHead(head: Meta): void {
  if (head.title !== undefined) document.title = head.title
  for (const el of document.head.querySelectorAll("[data-nifra]")) el.remove()
  // Values follow the same HTML attribute conventions as the SSR `tagAttrs`: a string sets the value,
  // `true` sets the bare boolean attribute, `false`/`undefined` skip it — so a soft-nav head matches
  // the server-rendered one exactly (no hydration drift on the managed tags).
  const add = (tag: "meta" | "link", attrs: Record<string, string | boolean | undefined>): void => {
    const el = document.createElement(tag)
    for (const [name, value] of Object.entries(attrs)) {
      if (value === undefined || value === false) continue
      el.setAttribute(name, value === true ? "" : value)
    }
    el.setAttribute("data-nifra", "")
    document.head.appendChild(el)
  }
  for (const m of head.meta ?? []) add("meta", m)
  for (const l of head.link ?? []) add("link", l)
}

export function installForms(router: ClientRouter): () => void {
  const onSubmit = (event: SubmitEvent): void => {
    if (event.defaultPrevented) return
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    if (form.method.toLowerCase() !== "post") return // GET forms submit natively
    const url = new URL(form.action) // resolved (or the current document URL if unset)
    if (url.origin !== location.origin) return
    if (router.match(url.pathname) === null) return // not an app route → native submit
    event.preventDefault()
    // `data-nifra-revalidate="false"` opts out of the post-action loader revalidation (the action's
    // actionData drives the update); absent or any other value keeps the default revalidation.
    const revalidate = form.dataset.nifraRevalidate !== "false"
    router.submit(url.pathname + url.search, new FormData(form), { revalidate }).catch(() => {
      form.submit() // data submit failed — fall back to a full-page POST
    })
  }
  document.addEventListener("submit", onSubmit)
  return () => document.removeEventListener("submit", onSubmit)
}

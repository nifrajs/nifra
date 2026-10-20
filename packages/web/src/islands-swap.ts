/**
 * @nifrajs/web/islands/swap - refresh one region of a server-rendered page from a plain link or form,
 * without a full reload and without a client router.
 *
 *   <form action="/hotels" data-swap="replace:results"><input name="q"></form>
 *   <ul data-swap-slot="results">...</ul>
 *   <a href="/hotels?page=2" data-swap="append:results">More</a>
 *
 * The request is the one the link or form makes anyway, plus an `x-nifra-swap: <slot>` header. The
 * server runs the page as usual and answers with that slot's HTML alone (`slot()` in
 * `@nifrajs/web-vanilla`), so the fragment is a slice of the real page. Any other answer - a redirect,
 * another origin, a page without that slot - loads the URL normally, except a POST's own page, which
 * is shown in place because the action has already run: a swap only ever speeds up what the link or
 * form already does, and without this script the page works the same way.
 */

import { type IslandEnhancer, mountIslands } from "./islands.ts"
import { SWAP_HEADER } from "./render-seam.ts"

/** Where `enableSwap` looks for links, forms, slots and islands. */
export interface SwapOptions {
  /** Default `document`. */
  readonly root?: Document | Element
}

const MODE = /^(replace|append):([A-Za-z][\w-]{0,63})$/
const SLOTS = "[data-swap-slot]:not([data-island-ignore],[data-island-ignore] *)"
const HISTORY_KEY = "nifraSwap"

// A control named like a DOM method shadows it on its form (`<input name="closest">`).
const attr = (el: Element, name: string): string | null =>
  Element.prototype.getAttribute.call(el, name)

const here = (): string => location.pathname + location.search

/** The slot names a history entry's swaps changed, from the first one in this tab up to it. */
const swappedIn = (state: unknown): string[] => {
  const names: unknown =
    typeof state === "object" && state !== null ? Reflect.get(state, HISTORY_KEY) : undefined
  return Array.isArray(names) ? names.filter((name) => typeof name === "string") : []
}

/**
 * Mount the page's islands, as `mountIslands` does, and make every `data-swap` link and form under
 * `root` refresh its slot in place. Call it instead of `mountIslands`.
 *
 * - `data-swap="replace:<slot>"` replaces the content of the `data-swap-slot="<slot>"` element;
 *   `append:<slot>` adds to it, and a link or form inside that slot is spent: the slot's child holding
 *   it is removed when the next content arrives, so a "more" link at the end of a list gives way to
 *   the next page and its own "more" link.
 * - A replacing GET pushes its URL, so a filtered list survives reload and can be shared; back and
 *   forward fetch the slots again for the URL they land on.
 * - The islands inside a slot mount with it and unmount when it is replaced.
 * - While a slot loads it carries `aria-busy="true"`; a newer swap of the same slot cancels the
 *   older one. When the request fails, the page stays as it is and the link or form gets
 *   `data-swap-error`.
 *
 * Nothing inside a `data-island-ignore` element swaps. Returns a disposer that removes the listeners,
 * cancels pending swaps and unmounts every island.
 */
export function enableSwap(
  // `never` admits an enhancer of any props type, as in `mountIslands`.
  enhancers: Readonly<Record<string, IslandEnhancer<never>>>,
  options: SwapOptions = {},
): () => void {
  const root: ParentNode & Node = options.root ?? document
  const stops = new Map<Node, () => void>()
  const pending = new Map<Element, AbortController>()
  let swapped = swappedIn(history.state)
  let shown = here()
  // Set once a POST's whole answer replaced the page: no history entry matches what is shown then.
  let replaced = false

  const own = (node: Node, stop: () => void): void => {
    const before = stops.get(node)
    stops.set(
      node,
      before === undefined
        ? stop
        : () => {
            before()
            stop()
          },
    )
  }
  // Innermost slots first, so each island belongs to the slot whose swap removes it.
  const attach = (scope: ParentNode & Node): void => {
    for (const slot of [...scope.querySelectorAll(SLOTS)].reverse())
      own(slot, mountIslands(enhancers, { root: slot }))
    own(scope, mountIslands(enhancers, { root: scope }))
  }
  const release = (scope: Node): void => {
    for (const [node, stop] of stops)
      if (scope.contains(node)) {
        stops.delete(node)
        stop()
      }
  }
  // The server answers with the first slot of a name in the page, so the client takes the first too.
  const slotNamed = (name: string): Element | undefined => {
    for (const slot of root.querySelectorAll(SLOTS))
      if (slot.getAttribute("data-swap-slot") === name) return slot
    return undefined
  }

  const put = (slot: Element, html: string, append: boolean, source: Element | undefined): void => {
    const template = document.createElement("template")
    // Parsed inert: scripts in it never run, as for any HTML set this way.
    template.innerHTML = html
    const focused = slot.contains(document.activeElement)
    if (append) {
      for (const child of [...slot.children])
        if (child === source || (source !== undefined && child.contains(source)))
          slot.removeChild(child)
      slot.append(template.content)
    } else {
      release(slot)
      slot.replaceChildren(template.content)
    }
    attach(slot)
    if (focused && !slot.contains(document.activeElement) && slot instanceof HTMLElement) {
      if (!slot.hasAttribute("tabindex")) slot.tabIndex = -1
      slot.focus({ preventScroll: true })
    }
  }

  // The page a native submit would show. Its scripts never run: this one is already running here.
  const showDocument = (html: string, url: URL): void => {
    const next = new DOMParser().parseFromString(html, "text/html")
    release(document)
    document.replaceChild(document.adoptNode(next.documentElement), document.documentElement)
    replaced = true
    history.pushState(null, "", url)
    scrollTo(0, 0)
    if (root === document) attach(root)
  }

  const swap = async (
    slot: Element,
    name: string,
    append: boolean,
    url: URL,
    method: string,
    body: FormData | URLSearchParams | null = null,
    source?: Element,
  ): Promise<void> => {
    pending.get(slot)?.abort()
    const abort = new AbortController()
    pending.set(slot, abort)
    slot.setAttribute("aria-busy", "true")
    const get = method === "GET"
    try {
      const response = await fetch(url, {
        method,
        body,
        headers: { [SWAP_HEADER]: name },
        signal: abort.signal,
        // A GET that redirects loads normally; a POST has run by then, so its redirect is followed
        // and the page it lands on is never sent the form a second time.
        redirect: get ? "manual" : "follow",
      })
      const load = (): void => {
        if (source === undefined) location.reload()
        else location.assign(response.redirected ? response.url : url)
      }
      if (
        response.type !== "basic" ||
        !response.headers.get("content-type")?.startsWith("text/html")
      ) {
        load()
        return
      }
      if (response.headers.get(SWAP_HEADER) !== name) {
        // A POST that did not redirect has run and this is its page: loading the URL again would
        // drop the action's result.
        if (get || response.redirected) load()
        else {
          const page = await response.text()
          try {
            showDocument(page, url)
          } catch {
            load()
          }
        }
        return
      }
      const html = await response.text()
      if (!slot.isConnected) return
      try {
        put(slot, html, append, source)
      } catch {
        // Trusted Types without a default policy refuses the HTML before the slot changes.
        load()
        return
      }
      if (get && !append && source !== undefined) {
        if (!swapped.includes(name)) swapped = [...swapped, name]
        history.pushState({ [HISTORY_KEY]: swapped }, "", url)
        shown = url.pathname + url.search
      }
    } catch {
      if (abort.signal.aborted) return
      // Back or forward left the URL ahead of the page: show what the URL shows.
      if (source === undefined) location.reload()
      else Element.prototype.setAttribute.call(source, "data-swap-error", "")
    } finally {
      if (pending.get(slot) === abort) {
        pending.delete(slot)
        slot.removeAttribute("aria-busy")
      }
    }
  }

  const start = (
    event: Event,
    source: Element,
    url: URL,
    method: string,
    body: FormData | URLSearchParams | null = null,
  ): void => {
    const mode = MODE.exec(attr(source, "data-swap") ?? "")
    const name = mode?.[2]
    if (
      name === undefined ||
      url.origin !== location.origin ||
      Element.prototype.closest.call(source, "[data-island-ignore]") !== null
    )
      return
    const slot = slotNamed(name)
    if (slot === undefined) return
    event.preventDefault()
    Element.prototype.removeAttribute.call(source, "data-swap-error")
    void swap(slot, name, mode?.[1] === "append", url, method, body, source)
  }

  const onClick = (event: Event): void => {
    if (!(event instanceof MouseEvent) || event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = event.target instanceof Element ? event.target.closest("a[data-swap]") : null
    if (!(link instanceof HTMLAnchorElement) || !link.hasAttribute("href")) return
    const target = link.getAttribute("target")
    if ((target !== null && target !== "" && target !== "_self") || link.hasAttribute("download"))
      return
    const url = new URL(link.href)
    // An in-page anchor keeps its native jump.
    if (url.hash !== "" && url.pathname + url.search === here()) return
    start(event, link, url, "GET")
  }

  const onSubmit = (event: Event): void => {
    const form = event.target
    if (
      !(event instanceof SubmitEvent) ||
      event.defaultPrevented ||
      !(form instanceof HTMLFormElement) ||
      attr(form, "data-swap") === null
    )
      return
    const submitter = event.submitter
    // The button that submitted can override the form's method, action, target and encoding.
    const pick = (name: string): string | null =>
      submitter?.hasAttribute(`form${name}`)
        ? submitter.getAttribute(`form${name}`)
        : attr(form, name)
    // An empty method is a GET, as for the browser.
    const method = (pick("method") || "get").toUpperCase()
    const target = pick("target")
    const enctype = pick("enctype")?.toLowerCase()
    if (
      (method !== "GET" && method !== "POST") ||
      (target !== null && target !== "" && target !== "_self") ||
      enctype === "text/plain"
    )
      return
    const url = new URL(pick("action") ?? "", document.baseURI)
    const data = new FormData(form, submitter)
    const fields = new URLSearchParams()
    for (const [key, value] of data)
      fields.append(key, typeof value === "string" ? value : value.name)
    if (method === "GET") url.search = fields.toString()
    start(
      event,
      form,
      url,
      method,
      method === "GET" ? null : enctype === "multipart/form-data" ? data : fields,
    )
  }

  const onPopState = (event: PopStateEvent): void => {
    if (replaced) location.reload()
    if (replaced || here() === shown) return
    shown = here()
    const reached = swappedIn(event.state)
    // Every slot a swap changed between the entry left and the one reached is in the later one's list.
    const names = new Set([...swapped, ...reached])
    swapped = reached
    const targets: Array<[string, Element]> = []
    for (const name of names) {
      const slot = slotNamed(name)
      if (slot === undefined) {
        location.reload()
        return
      }
      targets.push([name, slot])
    }
    for (const [name, slot] of targets) void swap(slot, name, false, new URL(location.href), "GET")
  }

  attach(root)
  root.addEventListener("click", onClick)
  root.addEventListener("submit", onSubmit)
  window.addEventListener("popstate", onPopState)
  return () => {
    root.removeEventListener("click", onClick)
    root.removeEventListener("submit", onSubmit)
    window.removeEventListener("popstate", onPopState)
    for (const abort of pending.values()) abort.abort()
    for (const stop of stops.values()) stop()
    stops.clear()
  }
}

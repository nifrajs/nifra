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
 * another origin, a page without that slot - loads the URL normally. Only GET requests are enhanced:
 * a POST form submits natively, so the browser applies its response's security policy and scripts,
 * and the form is never sent twice.
 */

import { mountIsland } from "./internal/island-mount.ts"
import type { IslandEnhancer } from "./islands.ts"
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
 * Mount the page's islands, as `mountIslands` does, and make every `data-swap` link and GET form under
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

  const islands = "[data-island]:not([data-island-ignore],[data-island-ignore] *)"
  const attach = (scope: ParentNode & Node): void => {
    const mount = (el: HTMLElement): void => {
      const stop = mountIsland(el, enhancers)
      if (stop !== undefined) stops.set(el, stop)
    }
    if (scope instanceof HTMLElement && scope.matches(islands)) mount(scope)
    for (const el of scope.querySelectorAll<HTMLElement>(islands)) if (scope.contains(el)) mount(el)
  }
  const release = (scope: Node): void => {
    const cleanups: Array<() => void> = []
    for (const [node, stop] of stops)
      if (scope.contains(node)) {
        stops.delete(node)
        cleanups.push(stop)
      }
    // Cleanup may itself detach descendants, so collect every owner before stopping any of them.
    for (const stop of cleanups) stop()
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
        if (child === source || (source !== undefined && child.contains(source))) {
          release(child)
          slot.removeChild(child)
        }
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

  const swap = async (
    slot: Element,
    name: string,
    append: boolean,
    url: URL,
    source?: Element,
  ): Promise<void> => {
    pending.get(slot)?.abort()
    const abort = new AbortController()
    pending.set(slot, abort)
    slot.setAttribute("aria-busy", "true")
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { [SWAP_HEADER]: name },
        signal: abort.signal,
        redirect: "manual",
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
      // A slot answer joins this document, so this document's CSP governs it, whatever headers the
      // fetch carried; anything that is not one loads as its own document under its own policy.
      if (response.headers.get(SWAP_HEADER) !== name) {
        load()
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
      if (!append && source !== undefined) {
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

  const start = (event: Event, source: Element, url: URL): void => {
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
    void swap(slot, name, mode?.[1] === "append", url, source)
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
    start(event, link, url)
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
      method !== "GET" ||
      (target !== null && target !== "" && target !== "_self") ||
      enctype === "text/plain"
    )
      return
    const action = pick("action")
    const url = new URL(action === null || action === "" ? location.href : action, document.baseURI)
    const data = new FormData(form, submitter)
    const fields = new URLSearchParams()
    for (const [key, value] of data)
      fields.append(key, typeof value === "string" ? value : value.name)
    url.search = fields.toString()
    start(event, form, url)
  }

  const onPopState = (event: PopStateEvent): void => {
    if (here() === shown) return
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
    for (const [name, slot] of targets) void swap(slot, name, false, new URL(location.href))
  }

  const listen = (method: "addEventListener" | "removeEventListener"): void => {
    root[method]("click", onClick)
    root[method]("submit", onSubmit)
  }

  attach(root)
  listen("addEventListener")
  window.addEventListener("popstate", onPopState)
  return () => {
    listen("removeEventListener")
    window.removeEventListener("popstate", onPopState)
    for (const abort of pending.values()) abort.abort()
    for (const stop of stops.values()) stop()
    stops.clear()
  }
}

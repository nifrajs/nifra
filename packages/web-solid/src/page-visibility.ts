/**
 * Whether a page is on screen, for a `keepAlive` page that stays mounted while it is hidden. Pages read
 * it through `@nifrajs/web-solid/router`; the keep-alive view provides it per kept slot.
 */
import { type Accessor, type Context, createContext, onCleanup, useContext } from "solid-js"

/** What one kept slot provides: whether it is hidden, and the callbacks it runs as that changes. */
export interface PageSlot {
  readonly hidden: Accessor<boolean>
  readonly hide: Set<() => void>
  readonly show: Set<() => void>
}

// A `globalThis` singleton for the same reason as the router's contexts (see router.ts).
const PAGE_CONTEXT_SLOT = Symbol.for("nifra.web-solid.page-context")
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: only this module writes the registry key, and it writes a page context
const pageContextSlot = globalThis as { [PAGE_CONTEXT_SLOT]?: Context<PageSlot | undefined> }
export const PageContext = pageContextSlot[PAGE_CONTEXT_SLOT] ?? createContext<PageSlot>()
pageContextSlot[PAGE_CONTEXT_SLOT] = PageContext

const ALWAYS: Accessor<boolean> = () => true

/**
 * Whether the page this component renders in is on screen, as an accessor: `false` while it is kept
 * hidden behind another page, where it keeps running. Always `true` on the server and on a page that
 * does not keep alive.
 */
export function usePageVisibility(): Accessor<boolean> {
  const slot = useContext(PageContext)
  return slot === undefined ? ALWAYS : () => !slot.hidden()
}

const onVisibility = (kind: "hide" | "show", callback: () => void): void => {
  const slot = useContext(PageContext)
  if (slot === undefined) return
  slot[kind].add(callback)
  onCleanup(() => slot[kind].delete(callback))
}

/**
 * Run `callback` each time the `keepAlive` page this component renders in is hidden behind another
 * page, before it leaves the document. The page keeps running while it is hidden: pause its timers,
 * sockets and media here. Call it while the component sets up; it is removed with the component. A
 * no-op outside a kept page.
 */
export function onPageHide(callback: () => void): void {
  onVisibility("hide", callback)
}

/** Run `callback` each time the `keepAlive` page this component renders in is shown again. */
export function onPageShow(callback: () => void): void {
  onVisibility("show", callback)
}

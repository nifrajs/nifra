/**
 * Whether a page is on screen, for a `keepAlive` page that stays mounted while it is hidden. Pages read
 * it through `@nifrajs/web-preact/router`; the keep-alive mount provides it.
 */
import { type Context, createContext } from "preact"
import { useContext, useLayoutEffect, useRef } from "preact/hooks"

/** The callbacks registered in one kept slot, run by the slot as it is hidden and shown again. */
export interface PageCallbacks {
  readonly hide: Set<() => void>
  readonly show: Set<() => void>
}

let visible: Context<boolean> | undefined
let callbacks: Context<PageCallbacks | undefined> | undefined
// Made on first use, so an app whose pages never read them carries none of it.
export const pageVisibilityContext = (): Context<boolean> => {
  visible ??= createContext(true)
  return visible
}
export const pageCallbacksContext = (): Context<PageCallbacks | undefined> => {
  callbacks ??= createContext<PageCallbacks | undefined>(undefined)
  return callbacks
}

/**
 * Whether the page this component renders in is on screen. `false` while it is kept hidden behind
 * another page, where its effects keep running: pause timers and listeners on it. Always `true` on the
 * server and on a page that does not keep alive.
 */
export function usePageVisibility(): boolean {
  return useContext(pageVisibilityContext())
}

const onVisibility = (kind: keyof PageCallbacks, callback: () => void): void => {
  const slot = useContext(pageCallbacksContext())
  const latest = useRef(callback)
  latest.current = callback
  useLayoutEffect(() => {
    if (slot === undefined) return
    const run = (): void => latest.current()
    slot[kind].add(run)
    return () => {
      slot[kind].delete(run)
    }
  }, [slot])
}

/**
 * Run `callback` each time the `keepAlive` page this component renders in is hidden behind another
 * page, before it leaves the document. The page keeps running while it is hidden: pause its timers,
 * sockets and media here. A hook: call it unconditionally while rendering. A no-op outside a kept page.
 */
export function onPageHide(callback: () => void): void {
  onVisibility("hide", callback)
}

/** Run `callback` each time the `keepAlive` page this component renders in is shown again. A hook. */
export function onPageShow(callback: () => void): void {
  onVisibility("show", callback)
}

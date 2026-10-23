/**
 * Whether a page is on screen, for a `keepAlive` page that stays mounted while it is hidden. Pages read
 * it through `usePageVisibility` from `@nifrajs/web-react/router`; the keep-alive mount provides it.
 */
import { type Context, createContext, useContext } from "react"

let visible: Context<boolean> | undefined
// Made on first use, so an app whose pages never read it carries none of it.
export const pageVisibilityContext = (): Context<boolean> => {
  visible ??= createContext(true)
  return visible
}

/**
 * Whether the page this component renders in is on screen. `false` while it is kept hidden behind
 * another page; its effects have cleaned up by then (`Activity`), and run again when it is shown.
 * Always `true` on the server and on a page that does not keep alive.
 */
export function usePageVisibility(): boolean {
  return useContext(pageVisibilityContext())
}

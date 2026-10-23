/** Dispatched on a kept page's element as the router hides it (`keepAlive`), while it is still in the
 * document and before the router's subscribers see the state that hides it. */
export const PAGE_HIDE_EVENT = "nifra:pagehide"
/** Dispatched on a kept page's element once it is shown again. */
export const PAGE_SHOW_EVENT = "nifra:pageshow"

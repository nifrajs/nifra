/** Dispatched on a kept page's element as the router hides it (`keepAlive`), while it is still in the
 * document and before the router's subscribers see the state that hides it. */
export const PAGE_HIDE_EVENT = "nifra:pagehide"
/** Dispatched on a kept page's element once it is shown again. */
export const PAGE_SHOW_EVENT = "nifra:pageshow"

const releases = new WeakMap<object, Set<() => void>>()

/** Run `release` once the kept page `page` leaves its view for good; the result cancels it. */
export function onPageRelease(page: object, release: () => void): () => void {
  let pending = releases.get(page)
  if (pending === undefined) {
    pending = new Set()
    releases.set(page, pending)
  }
  pending.add(release)
  return () => {
    pending.delete(release)
  }
}

/** The kept page `page` left its view: what its hidden content set aside goes. */
export function releasePage(page: object): void {
  const pending = releases.get(page)
  releases.delete(page)
  for (const release of pending ?? []) release()
}

/**
 * How a client navigation's page swap reaches the screen. The router loads a page first and hands only
 * the swap here, so the history layer can wrap the swap alone in a view transition rather than the
 * whole load. Module-scoped: one app per page; unset on the server and without `installHistory`.
 */
export type Presenter = (swap: () => void) => Promise<void>

let presenter: Presenter | undefined

/** Set (or clear, with `undefined`) the presenter - called by `installHistory`. */
export function setPresenter(next: Presenter | undefined): void {
  presenter = next
}

/** Run `swap` through the presenter, or at once when none is set. */
export function present(swap: () => void): Promise<void> | undefined {
  if (presenter !== undefined) return presenter(swap)
  swap()
  return undefined
}

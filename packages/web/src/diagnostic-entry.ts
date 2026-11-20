/** The shape of one recognised failure, and the ownership test the prefix-based entries share. */

/** One labeled way to fix a recognised failure. */
export interface FixOption {
  readonly label: string
  readonly fix: string
}

/** A recognised failure shape: a stable code plus the plain-language cause/fix/anchor to attach. */
export interface CatalogEntry {
  readonly code: string
  /** `fromNifra` is true when the error was thrown from inside a nifra package, so a plain
   * validation message from the framework is not confused with one the app threw itself. */
  readonly match: (name: string, message: string, fromNifra: boolean) => boolean
  readonly cause: string
  readonly fix: string
  readonly docsAnchor: string
  readonly options?: readonly FixOption[]
  /** Reported by a console warning, not thrown: the dev feed records the warning as an entry. */
  readonly console?: true
  /**
   * How seriously to treat a recognised failure. Absent means an error. A framework's own development
   * warning is a "warning": the dev feed lists it, but it does not fail `nifra errors`.
   */
  readonly severity?: "warning" | ((message: string, name: string) => "error" | "warning")
}

/**
 * A feature-prefixed message is nifra's only when the error came from a nifra package or the prefix
 * names nifra itself: an app that throws `saga: not found` is not reporting a nifra failure.
 */
export const nifraOwned = (message: string, fromNifra: boolean, prefix: RegExp): boolean =>
  (fromNifra || /^(?:\[nifra|@nifrajs\/)/.test(message)) && prefix.test(message)

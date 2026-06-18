/**
 * Single source of truth for the framework's user-facing name.
 *
 * Every developer-facing string (error prefixes, the default OpenAPI title, the
 * logger tag) pulls from here, so renaming the brand is a one-line change. The
 * npm scope (`@nifrajs/*`) is the other naming axis — `scripts/rename.ts` flips
 * both at once.
 */
export const FRAMEWORK_NAME = "Nifra" as const

export type FrameworkName = typeof FRAMEWORK_NAME

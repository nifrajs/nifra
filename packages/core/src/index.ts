/**
 * `@nifrajs/core` — Nifra's lean HTTP server API.
 *
 * Nifra 2.0 keeps the package root intentionally lean. Optional systems live at documented
 * subpaths so importing the root cannot activate unrelated runtimes.
 */

/**
 * Current package version. A hardcoded literal on purpose — core runs on the edge (no fs), so it can't
 * read its own package.json at runtime. `scripts/version.ts` rewrites it on every release bump and
 * `check:publish` asserts it equals `@nifrajs/core`'s package version.
 */
export const VERSION = "2.2.0" as const

export type Version = typeof VERSION

export * from "./server.ts"

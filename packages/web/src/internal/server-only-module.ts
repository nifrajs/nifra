/**
 * The `.server` convention, owned in one place.
 *
 * Four things need to agree on what a server-only module IS: the Bun client build, the Vite client
 * build, the Vite dev server, and `nifra dev --bun`'s refusal (which cannot transform, so it must
 * refuse instead). When each re-encoded the rule, they drifted - a hand-written glob
 * `**\/*.server.{ts,tsx,js,jsx,...}` missed the extensionless `db.server` that the regex matches, which
 * is a module the build empties and the guard waves through.
 *
 * A matcher that decides whether secrets reach a browser gets exactly one definition.
 */

/** Matches `db.server.ts`, `auth.server.tsx`, `x.server.mjs`, and the extensionless `foo.server`. */
export const SERVER_ONLY_MODULE = /\.server(\.[cm]?[jt]sx?)?$/

/**
 * The replacement body for an emptied module. A Proxy rather than `export {}` so any named OR default
 * import resolves to `undefined` instead of failing the bundle with a missing-export error - the client
 * degrades at the call site it wrote, not at link time in a file it never named.
 *
 * Shared so the Bun and Vite pipelines emit the same bytes; a parity test asserts it.
 */
export const SERVER_ONLY_REPLACEMENT = "module.exports = new Proxy({}, { get: () => undefined })"

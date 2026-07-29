/**
 * `@nifrajs/web/plugins/vite-server-only` - the Vite half of the `.server` convention.
 *
 * A module named `*.server.ts(x)` is server-only: the Bun client build empties it so its import
 * subtree - `node:` builtins, native modules, secrets - never reaches a browser. This does the same
 * for Vite, in both the dev server and the production build.
 *
 * ## Why this exists separately
 *
 * The convention was implemented once, as a `Bun.build` plugin, which meant it held in exactly one of
 * the four pipelines. `nifra build` emptied the module; `nifra dev` (Vite), a Vite production build,
 * and `nifra dev --bun` all shipped it whole. A guard that holds in one pipeline and not the others is
 * worse than none, because the file name reads as protection everywhere.
 *
 * `*.fn` already had this shape - a Bun plugin, a Vite plugin, and a refusal in the one pipeline that
 * cannot transform. `.server` now matches it.
 *
 * ## Why `transform` and not `load`
 *
 * Vite resolves and reads the file itself; taking `load` would mean re-implementing its resolution.
 * `transform` receives the source Vite already read, and returning replacement code discards the
 * original along with its imports - so the server subtree is never followed. `enforce: "pre"` puts
 * this ahead of framework transforms, which have no business seeing server code either.
 */

/** Matches `db.server.ts`, `auth.server.tsx`, `x.server.mjs`, and the extensionless `foo.server`. */
export const SERVER_ONLY_MODULE = /\.server(\.[cm]?[jt]sx?)?$/

/**
 * The replacement body. A Proxy rather than `export {}` so any named OR default import resolves to
 * `undefined` instead of failing the bundle with a missing-export error - the client should degrade at
 * the call site it wrote, not blow up at link time in a file it never named. Byte-identical to what
 * the Bun plugin emits, so the two pipelines produce the same client.
 */
export const SERVER_ONLY_REPLACEMENT = "module.exports = new Proxy({}, { get: () => undefined })"

/** The slice of a Vite/Rollup plugin this returns. Structural, so `vite` stays an optional peer. */
export interface ServerOnlyEmptyPlugin {
  readonly name: string
  readonly enforce: "pre"
  /** Applied only to the CLIENT build; the server build keeps the real module. */
  readonly applyToEnvironment?: (environment: { readonly name: string }) => boolean
  transform(code: string, id: string): { code: string; map: null } | null
}

/** Strips a Vite id's `?query` and `#hash` so the suffix test sees a plain path. */
const bare = (id: string): string => id.split("?")[0]?.split("#")[0] ?? id

/**
 * Empty every `*.server` module in the client build.
 *
 * Client-only by construction: nifra passes this to the client build and the dev server, never to the
 * SSR build, where the real module is what runs.
 */
export function viteServerOnlyEmpty(): ServerOnlyEmptyPlugin {
  return {
    name: "nifra:server-only-empty",
    enforce: "pre",
    // Vite 6+ environments: the SSR environment must keep the real module. Older Vite ignores this and
    // relies on nifra only registering the plugin on the client side.
    applyToEnvironment: (environment) => environment.name === "client",
    transform(_code, id) {
      const path = bare(id)
      if (!SERVER_ONLY_MODULE.test(path)) return null
      // `map: null` is honest rather than lazy: the replacement shares no lines with the source, so any
      // mapping would point a debugger at unrelated code.
      return { code: SERVER_ONLY_REPLACEMENT, map: null }
    },
  }
}

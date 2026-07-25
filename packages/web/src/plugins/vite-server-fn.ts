/**
 * `@nifrajs/web/plugins/vite-server-fn` - the Vite half of the server-function client transform.
 *
 * A `*.fn` module must never reach a browser: it holds the function bodies and everything they import.
 * The Bun build replaces each one with client stubs, and this does the same for Vite, in both the dev
 * server and the production build.
 *
 * ## Why the generation is not in here
 *
 * The stub text comes from `internal/server-fn-stub.ts`, shared verbatim with the Bun plugin. Two
 * implementations of "what a stub looks like" would drift, and the drift would be invisible until a
 * client that worked in dev 404'd in production - the exact shape of failure this codebase has already
 * paid for once. A parity test asserts both pipelines emit the same bytes.
 *
 * ## Why `transform` and not `load`
 *
 * Vite resolves and reads the file itself; taking `load` would mean re-implementing its resolution.
 * `transform` receives the source Vite already read, and returning replacement code discards the
 * original along with its imports - so the server subtree is never followed. `enforce: "pre"` puts this
 * ahead of framework transforms, which have no business seeing server code either.
 */
import {
  generateServerFnStub,
  SERVER_FN_MODULE,
  serverFnNamespace,
} from "../internal/server-fn-stub.ts"

/** The slice of a Vite/Rollup plugin this returns. Structural, so `vite` stays an optional peer. */
export interface ServerFnStubPlugin {
  readonly name: string
  readonly enforce: "pre"
  /** Applied only to the CLIENT build; the server build keeps the real module. */
  readonly applyToEnvironment?: (environment: { readonly name: string }) => boolean
  transform(code: string, id: string): { code: string; map: null } | null
}

/** Strips a Vite id's `?query` and `#hash` so the suffix test sees a plain path. */
const bare = (id: string): string => id.split("?")[0]?.split("#")[0] ?? id

/**
 * Replace every `*.fn` module with its client stubs.
 *
 * Client-only by construction: nifra passes this to the client build and the dev server, never to the
 * SSR build, because the server is what actually runs these functions.
 */
export function viteServerFnStub(): ServerFnStubPlugin {
  return {
    name: "nifra:server-fn-stub",
    enforce: "pre",
    // Vite 6+ environments: the SSR environment must keep the real module. Older Vite ignores this and
    // relies on nifra only registering the plugin on the client side.
    applyToEnvironment: (environment) => environment.name === "client",
    transform(code, id) {
      const path = bare(id)
      if (!SERVER_FN_MODULE.test(path)) return null
      // `map: null` is honest rather than lazy: the stub shares no lines with the source, so any
      // mapping would point a debugger at unrelated code.
      return { code: generateServerFnStub(code, serverFnNamespace(path)), map: null }
    },
  }
}

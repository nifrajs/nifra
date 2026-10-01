/**
 * `@nifrajs/web/backend-only` - the poison-import marker (Next's `import "server-only"`). A module that
 * must never reach a browser can say so with a side-effect import at its top:
 *
 *     import "@nifrajs/web/backend-only"
 *
 * Every browser build and dev server refuses a module graph that reaches this specifier, naming the
 * import chain. The zone rules already keep `backend/` and `*.backend.ts` out of the browser; the
 * marker is for a module that must stay server-side wherever it is imported from, such as one inside
 * a shared workspace package. On the server it is an empty module, so the marked file runs untouched.
 *
 * Pair it with the type-level {@link BackendOnly} brand (from `@nifrajs/web`) on the module's exports.
 */

// Intentionally empty: the marker is the import itself.
export {}

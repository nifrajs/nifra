/**
 * `@nifrajs/web/server-only` — the **explicit, opt-in poison-import marker** (Next's `import
 * "server-only"`). A module of PURE server logic that carries no `node:` import — a secret-bearing
 * constant, a server-only API call — can't be caught by nifra's other two client-leak guards: the
 * `.server` convention (which empties `*.server` modules in the client build) needs the file to be
 * NAMED `*.server`, and the node-builtin guard only fires when a `node:` import actually reaches a
 * client chunk. This marker closes that gap: drop a side-effect import at the top of the module —
 *
 *     import "@nifrajs/web/server-only"
 *
 * — and the CLIENT build ({@link buildClient}) FAILS LOUD, naming the import chain, if that module
 * ever lands in a browser chunk. On the SERVER build/runtime it's a harmless no-op (this empty
 * module), so the same file runs untouched server-side.
 *
 * Pair it with the type-level {@link ServerOnly} brand (from `@nifrajs/web`) on the module's exports
 * to signal intent to readers + the compiler; this runtime import is what actually fails the build.
 *
 * @see ServerOnly — the type-level intent marker that complements this runtime import.
 */

// Intentionally empty. The marker is the IMPORT itself: `buildClient` detects any module that imports
// this specifier and lands in a client chunk (via the same Bun metafile graph the node-builtin guard
// walks) and fails the build. There is no value to export and nothing to run — on the server it's a
// no-op so the marked module behaves normally; on the client the build never completes.
export {}

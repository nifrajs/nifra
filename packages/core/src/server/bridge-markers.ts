/**
 * Wire marker keys shared between @nifrajs/core and the @nifrajs/node adapter.
 *
 * Each entry names a symbol looked up with `Symbol.for(...)`, so the two packages agree ONLY by the
 * string. A rename on one side and not the other is a silent protocol break - no type error, just a
 * symbol that never matches and a body that stops taking the direct-write lane. This module is the
 * single source: core defines its own symbols from these literals, and `scripts/gen-node-outcome.ts`
 * copies the map verbatim into the adapter's generated contract, so @nifrajs/node reads the identical
 * strings without a runtime dependency on core (the same deployment shape the generated outcome type
 * preserves).
 *
 * Keep this module import-free: every core file that owns one of these symbols imports it, so a cycle
 * here would reach most of the response path.
 */
export const NODE_BRIDGE_MARKER_KEYS = {
  /** A `Response` carrying its already-serialized bytes, so the Node writer emits them without a drain. */
  responseBody: "nifra.response.body",
  /** A plain-data response-result carrier the node lane renders without building a `Response`. */
  responseResult: "nifra.response.result",
  /** Proof that a header record's names are already the lowercase wire spelling. */
  lowercaseHeaderKeys: "nifra.headers.lowercase",
  /** A mounted handler's node-direct resolver entry point. */
  resolveNodeMount: "@nifrajs/core/resolve-node-mount",
} as const

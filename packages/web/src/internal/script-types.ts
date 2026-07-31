/**
 * The `type` values each head-script slot accepts, owned in one place because both halves enforce it:
 * the server's `headTags` and the client's `applyHead` on a soft navigation. A head that renders and
 * then throws on the next navigation is worse than one that never rendered.
 *
 * Allowlists rather than escaping. Both slots interpolate `type` into an attribute, and a value
 * outside these sets is a mistake - emitting an escaped version of it would produce a `<script>` the
 * browser treats as inert data under a name nobody meant. Escaping is for values; this is a keyword.
 */

/** Data, never executed by the browser. */
export const INERT_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  "application/ld+json",
  "application/json",
])

/** Executed. Only reachable through `unsafeScript`, which additionally requires a CSP nonce. */
export const EXECUTABLE_SCRIPT_TYPES: ReadonlySet<string> = new Set(["module", "text/javascript"])

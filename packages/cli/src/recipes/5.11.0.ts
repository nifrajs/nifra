import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.11.
 *
 * This release has no import or dependency moves. Its notes cover the CLI session and upgrade
 * changes, the new route-slot and cache behavior, and the tightened security boundaries in the
 * fixed package groups.
 */
export const recipe: UpgradeRecipe = {
  version: "5.11.0",
  pins: [
    { match: "@nifrajs/", to: "5.11.0" },
    { match: "create-nifra", to: "5.11.0" },
    { match: "nifra", to: "5.11.0" },
  ],
  importMoves: [],
  affects: [
    "@nifrajs/a2a",
    "@nifrajs/agent",
    "@nifrajs/auth",
    "@nifrajs/authjs",
    "@nifrajs/better-auth",
    "@nifrajs/cli",
    "@nifrajs/core",
    "@nifrajs/middleware",
    "@nifrajs/uploads",
    "@nifrajs/web",
    "@nifrajs/web-preact",
    "@nifrajs/web-react",
    "@nifrajs/web-solid",
    "@nifrajs/web-svelte",
    "@nifrajs/web-vue",
    "create-nifra",
    "nifra",
  ],
  notes: [
    "During an MCP session, `nifra mcp` now takes over when the project installs a different `@nifrajs/cli`, replays the handshake, and sends `notifications/tools/list_changed`; a CLI that does not answer stays on the current session.",
    "`nifra upgrade --from <version>` names the starting release when package pins were bumped by hand. Unknown options and extra arguments are refused, and the `servePublicDir` rewrite preserves the file's quote style.",
    "`nifra doctor` reports a renamed session cookie only when the wrapper gives `sessionToken.name` a string, so a type-only wrapper no longer asks for `identityCookies`.",
    "Route slots can be addressed independently with typed targets and server allowlists, with bindings for the supported web adapters. Existing routes keep their behavior unless they opt into a slot.",
    "`withIdleTimeout(c, seconds, work)` accepts any route context, including contexts with body, query, or header schemas.",
    "Auth guard denials share the `@nifrajs/core/guard-deny` owner and fail loudly when a denial both redirects and answers or uses a status outside 400-599; the auth packages keep their existing prefixes and options.",
    "React server-component owner refreshes can progressively commit ready Suspense content through a bounded Flight stream. Request-dependent owner routes fail closed for shared storage, and `revalidateEndpoint({ app, store, secret })` purges an owner route by path.",
    "Rate-limit headers must contain one valid IP address; valid values are canonicalized, and invalid values use the configured trusted fallback or fail closed.",
    "A2A JSON/SSE output and agent SSE frames are bounded before serialization, so oversized output is rejected before it is constructed.",
    "Uploads reject oversized image dimensions before metadata stripping decodes the source, with a stable `ImagePixelLimitError`.",
    "Nonce-bearing hash-CSP owner documents stay out of shared caches, and non-200 refusals no longer memoize an owner URL as uncacheable.",
    "The href-navigation upgrade rewrite wraps whole string destinations in `rawHref(path)` while leaving dynamic expressions and templates for manual or type-check guidance; use the typed `href()` helper for an app-owned page when possible.",
  ],
}

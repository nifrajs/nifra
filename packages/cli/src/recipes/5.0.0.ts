import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.0.
 *
 * The runner pins the fixed group and lists every retired `@nifra-gate-reviewed` comment. It never
 * writes the `nifra-expect` comment that replaces one: a reason it made up would silence a finding
 * nobody reviewed.
 */
export const recipe: UpgradeRecipe = {
  version: "5.0.0",
  pins: [
    { match: "@nifrajs/", to: "5.0.0" },
    { match: "create-nifra", to: "5.0.0" },
    { match: "nifra", to: "5.0.0" },
  ],
  importMoves: [],
  retiredMarkers: [
    {
      marker: "@nifra-gate-reviewed",
      instead: "// nifra-expect <code>: <reason>, with the code nifra check reports there",
    },
  ],
  notes: [
    "`@nifra-gate-reviewed` silences nothing. After review, silence one finding with `// nifra-expect <code>: <reason>` on its line or anywhere in the comment block above it. The upgrade lists every old comment and the line it covered; it never writes a reason. Every security finding and every error needs the reason, so `// nifra-expect route-overlap` (NF-C024, NF-C025) without one no longer silences the overlap.",
    "`nifra check` reports a secret comparison (NF-S002) as advisory only in browser code inside a nifra web app: a directory with `nifra.config.ts` or `backend/framework.ts`, or whose nearest package.json depends on `@nifrajs/web` or a `@nifrajs/web-*` adapter. The same comparison in `routes/` or `frontend/` of an API-only project, or of a package without a web dependency, fails the check.",
    "A WebSocket handshake runs the route chain an HTTP `GET` registered at the same point runs: `authenticate()`, auth middleware, `derive` and `beforeHandle` added before `app.ws()` guard the socket and can refuse the handshake. Register a socket before the guard to keep it public.",
  ],
}

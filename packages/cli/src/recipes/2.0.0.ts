import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for the Nifra 2.0 fixed-group cutover.
 *
 * The runner handles deterministic package pins and the removed budget import. Structural API changes
 * stay as explicit notes so the tool never guesses at application intent.
 */
export const recipe: UpgradeRecipe = {
  version: "2.0.0",
  pins: [
    { match: "@nifrajs/", to: "2.0.0" },
    { match: "create-nifra", to: "2.0.0" },
    { match: "nifra", to: "2.0.0" },
  ],
  dependencyMoves: [{ from: "@nifrajs/budget", to: "@nifrajs/core", toVersion: "2.0.0" }],
  importMoves: [{ from: "@nifrajs/budget", to: "@nifrajs/core/budget" }],
  notes: [
    "Read the 1.x → 2.0 migration guide: https://nifra.dev/docs/migrate-2.",
    "Optional server systems are instance-scoped plugins in 2.0. Add `.use(idempotency())`, `.use(effectLedger())`, `.use(mcp())`, `.use(streaming())`, `.use(websocket())`, or `.use(nodeDirect())` where used.",
    "The old `@nifrajs/budget` package is removed. This recipe moves its dependency to `@nifrajs/core` and its imports to `@nifrajs/core/budget`.",
    "Custom web backend mounts must implement the symbol-keyed BackendMount interface. `inProcessClient(app)` and `testClient(app)` already do.",
    'If Better Auth or another library owns a non-Nifra route prefix, declare it in `nifra.check.json`, for example `{ "externalMounts": ["/auth"] }`.',
    "Client failures with declared error schemas now narrow by `status`; narrow `res.status` before reading failure data.",
  ],
}

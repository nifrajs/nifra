import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for nifra 1.8.0.
 *
 * 1.8.0 is a fixed-group bump: every `@nifrajs/*` package moves in lockstep. The pin sweep sets them
 * all to 1.8.0 (preserving each spec's `^`/`~`/exact style). 1.8.0 introduced no breaking import moves
 * in the public packages — the new surfaces (route assurance, adversarial testing, `@nifrajs/events`)
 * are additive — so `importMoves` is empty. The notes flag the additive follow-ups a bump can't do for
 * you (wiring the new assurance config), keeping the runner honest about what it did and didn't touch.
 */
export const recipe: UpgradeRecipe = {
  version: "1.8.0",
  pins: [{ match: "@nifrajs/", to: "1.8.0" }],
  importMoves: [],
  notes: [
    "1.8.0 adds route assurance (@nifrajs/core + middleware) — optional. To enforce it in CI, add a `nifra.assurance.ts` policy and run `nifra assure`.",
    "New package @nifrajs/events (portable versioned event contracts) — add it to package.json only if you adopt it; the pin sweep won't introduce a dependency you don't already declare.",
    "@nifrajs/testing gained the adversarial contract lab — no migration needed; existing tests are unchanged.",
  ],
}

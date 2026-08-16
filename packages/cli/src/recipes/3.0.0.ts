import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for the Nifra 3.0 fixed-group cutover.
 *
 * No package is removed and no import specifier moves this release, so the runner only pins the
 * fixed version group. The two breaking changes are structural - a redirect return value and the
 * reserved typed-client segment types - and stay as explicit notes, one of which points at a codemod.
 */
export const recipe: UpgradeRecipe = {
  version: "3.0.0",
  pins: [
    { match: "@nifrajs/", to: "3.0.0" },
    { match: "create-nifra", to: "3.0.0" },
    { match: "nifra", to: "3.0.0" },
  ],
  importMoves: [],
  notes: [
    "Read the 2.x → 3.0 migration guide: https://nifra.dev/docs/migrate-3.",
    "`redirect(...)` now returns plain render data, not a `Response`. Read it with `.plain` (`{ status, headers, body }`) or `toResponse()`, add headers with the second argument, and assert on `.plain` in tests. `return redirect()` / `throw redirect()` are unchanged, and cookies still apply.",
    "Reserved typed-client segment keys are a frozen contract: a property or bracket access on a reserved-named route segment no longer type-checks. Run `nifra fix --code NF-C018` to rewrite the affected call sites; `nifra routes` annotates a colliding route with the spelling that reaches it.",
    "On Node, `@nifrajs/proxy` defaults to the undici transport. Pass an explicit `transport` to `createProxy` to override it.",
  ],
}

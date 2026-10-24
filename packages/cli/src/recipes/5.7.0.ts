import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.7.
 *
 * The React Auth.js bindings move from `@nifrajs/web-react/auth` to `@nifrajs/authjs/react`, so the
 * React adapter no longer names Auth.js at all. The import moves mechanically.
 */
export const recipe: UpgradeRecipe = {
  version: "5.7.0",
  pins: [
    { match: "@nifrajs/", to: "5.7.0" },
    { match: "create-nifra", to: "5.7.0" },
    { match: "nifra", to: "5.7.0" },
  ],
  importMoves: [{ from: "@nifrajs/web-react/auth", to: "@nifrajs/authjs/react" }],
  notes: [
    "`<AuthSessionProvider>` and `useAuthSession()` are imported from `@nifrajs/authjs/react`; `@nifrajs/web-react/auth` is removed. An app using them already installs `@nifrajs/authjs`, which now takes `react` as an optional peer. The useAuthSession error outside a provider reads `[nifra/authjs]`, where it read `[nifra/web-react]`.",
  ],
  affects: ["@nifrajs/authjs", "@nifrajs/web-react"],
}

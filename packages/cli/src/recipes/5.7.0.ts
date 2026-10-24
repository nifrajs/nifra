import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.7.
 *
 * The React Auth.js bindings move from `@nifrajs/web-react/auth` to `@nifrajs/authjs/react`, so the
 * React adapter no longer names Auth.js at all. The import moves mechanically. The UI adapters take
 * `@nifrajs/image` and `@nifrajs/i18n` as optional peers, which an app using them installs itself.
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
    "`@nifrajs/image` and `@nifrajs/i18n` are optional peers of `@nifrajs/web-react`, `web-vue`, `web-svelte`, `web-solid` and `web-preact`, where they were dependencies. An app importing an adapter's `/image` entry adds `@nifrajs/image` to its dependencies, and one importing `/i18n` adds `@nifrajs/i18n`; without it the import fails to resolve. An app that already lists the package needs no change.",
    "`@nifrajs/web-react` no longer depends on `@nifrajs/schema`, so an app that imports `@nifrajs/schema` without listing it in its own dependencies has to add it.",
  ],
  affects: [
    "@nifrajs/authjs",
    "@nifrajs/web-preact",
    "@nifrajs/web-react",
    "@nifrajs/web-solid",
    "@nifrajs/web-svelte",
    "@nifrajs/web-vue",
  ],
}

import type { UpgradeRecipe } from "./index.ts"

const ADAPTERS = [
  "@nifrajs/web-react",
  "@nifrajs/web-vue",
  "@nifrajs/web-svelte",
  "@nifrajs/web-solid",
  "@nifrajs/web-preact",
]

/**
 * Upgrade recipe for Nifra 5.7.
 *
 * The React Auth.js bindings move from `@nifrajs/web-react/auth` to `@nifrajs/authjs/react`, so the
 * React adapter no longer names Auth.js at all. The import moves mechanically. The UI adapters take
 * `@nifrajs/image` and `@nifrajs/i18n` as optional peers, and web-react drops `@nifrajs/schema`, so
 * each package an app reached only through an adapter is added beside it where a file imports it.
 */
export const recipe: UpgradeRecipe = {
  version: "5.7.0",
  pins: [
    { match: "@nifrajs/", to: "5.7.0" },
    { match: "create-nifra", to: "5.7.0" },
    { match: "nifra", to: "5.7.0" },
  ],
  importMoves: [{ from: "@nifrajs/web-react/auth", to: "@nifrajs/authjs/react" }],
  dependencyAdds: [
    { imports: ["@nifrajs/authjs"], add: "@nifrajs/authjs", beside: ["@nifrajs/web-react"] },
    { imports: ADAPTERS.map((adapter) => `${adapter}/image`), add: "@nifrajs/image" },
    { imports: ADAPTERS.map((adapter) => `${adapter}/i18n`), add: "@nifrajs/i18n" },
    { imports: ["@nifrajs/schema"], add: "@nifrajs/schema", beside: ["@nifrajs/web-react"] },
  ],
  notes: [
    "`<AuthSessionProvider>` and `useAuthSession()` are imported from `@nifrajs/authjs/react`; `@nifrajs/web-react/auth` is removed. `@nifrajs/web-react` no longer brings `@nifrajs/authjs` in, so `nifra upgrade` adds it beside `@nifrajs/web-react` in each package.json above a file that imports it without listing it. `@nifrajs/authjs` takes `react` as an optional peer. The useAuthSession error outside a provider reads `[nifra/authjs]`, where it read `[nifra/web-react]`.",
    "`@nifrajs/image` and `@nifrajs/i18n` are optional peers of `@nifrajs/web-react`, `web-vue`, `web-svelte`, `web-solid` and `web-preact`, where they were dependencies, so an adapter's `/image` or `/i18n` entry fails to resolve unless the app lists the package. `nifra upgrade` adds it beside the adapter in each package.json above a file that imports the entry; an app that already lists it needs no change.",
    "`@nifrajs/web-react` no longer depends on `@nifrajs/schema`, so `nifra upgrade` adds `@nifrajs/schema` beside `@nifrajs/web-react` in each package.json above a file that imports it without listing it.",
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

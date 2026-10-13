import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.2.
 *
 * No import or dependency moves. Three changes alter what a 5.1 app serves, and the development audit,
 * `nifra check`, `nifra i18n check` and the upgrade itself report more; each note says what changes and
 * what keeps the old answer.
 */
export const recipe: UpgradeRecipe = {
  version: "5.2.0",
  pins: [
    { match: "@nifrajs/", to: "5.2.0" },
    { match: "create-nifra", to: "5.2.0" },
    { match: "nifra", to: "5.2.0" },
  ],
  importMoves: [],
  notes: [
    "A closed request-header schema (`headers: t.object({...})`) validates only the header names it declares, read case-insensitively. It used to see every header a client sends (`host`, `user-agent`), so such a route answered real requests with 422; those requests are now served. Use `t.headers({...})` for an open header slot.",
    '`responseContract("enforce", { extra: "strip" })` projects a union whose object branches all require one key holding literals no two branches share (`ok: true` / `ok: false`). When those branches are closed `t.object`s, a payload that carried undeclared fields used to answer 500; it is now sent without them.',
    'The development `unusedScopedHooks` audit also reports a hook only `merge()`d routes follow (a merged route keeps its own server\'s chain), an `authenticate()` after the last route, and a `responseContract()` or `effectLedger()` installed after routes it would have covered. With `unusedScopedHooks: "error"` each now throws at startup outside production: move the call before the routes, or wire the hook on the merged server.',
    "`nifra check` adds NF-C043 (warning): a parent's `authenticate()` or authenticated scope precedes a `merge()` of a server that authenticates none of its routes. Wire the auth on that server, or mark the merge `// nifra-expect NF-C043: <reason>`.",
    "`nifra check`'s capability walk also starts from the module that registered each route, recorded while `nifra.assurance.ts` loads the app, so a route it could not see before (a computed path, a helper-built server) is now checked and may report an undeclared capability.",
    "`nifra check`'s NF-C035 also reads app modules that call `createWebApp` themselves: a call that mounts `api` with no `apiPrefix`, or with one other than the framework config's, is reported. Import the `apiPrefix` from `backend/framework.ts` so both read one value.",
    '`nifra i18n check` and `checkCatalogs()` report two new errors: `latin-share`, a message in a locale that does not write in Latin whose words are mostly Latin script, and `volume`, a long default message translated to under a third of its length. List kept brand names in `latinWords`, raise `maxLatinShare` or lower `minVolumeRatio`, or list the keys under `ignore` (`"*"` for every key) to keep the old answer.',
    "`alternates()` from `@nifrajs/i18n/routing` given `locales` of a single locale returns no links, where it returned one self-reference.",
    "In a project that declares `@nifrajs/cli`, `nifra upgrade --write` drops the version pin from the MCP launch (`bunx @nifrajs/cli mcp`) so it runs the installed CLI from then on; restart the agent afterwards. `nifra upgrade --write` now refuses while a `link:` or `file:` dependency installs another nifra version, naming the commands for that repository; `--allow-linked-skew` proceeds anyway.",
  ],
}

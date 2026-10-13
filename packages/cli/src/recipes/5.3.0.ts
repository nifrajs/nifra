import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.3.
 *
 * No import or dependency moves, and nothing a 5.2 app serves changes. The development audit and
 * `nifra check` report more, and the upgrade itself refuses a linked repository on another nifra;
 * each note says what is new and how to answer it.
 */
export const recipe: UpgradeRecipe = {
  version: "5.3.0",
  pins: [
    { match: "@nifrajs/", to: "5.3.0" },
    { match: "create-nifra", to: "5.3.0" },
    { match: "nifra", to: "5.3.0" },
  ],
  importMoves: [],
  notes: [
    'The development `unusedScopedHooks` audit also reports a hook only `merge()`d routes follow (a merged route keeps its own server\'s chain), an `authenticate()` after the last route, and a `responseContract()` or `effectLedger()` installed after routes it would have covered. With `unusedScopedHooks: "error"` each now throws at startup outside production: move the call before the routes, or wire the hook on the merged server.',
    "`nifra check` adds NF-C043 (warning): a parent's `authenticate()` or authenticated scope precedes a `merge()` of a server that authenticates none of its routes. Wire the auth on that server, or mark the merge `// nifra-expect NF-C043: <reason>`.",
    "`nifra check`'s capability walk also starts from the module that registered each route, recorded while `nifra.assurance.ts` loads the app, so a route it could not see before (a computed path, a helper-built server) is now checked and may report an undeclared capability.",
    "In a project that declares `@nifrajs/cli`, `nifra upgrade --write` drops the version pin from the MCP launch (`bunx @nifrajs/cli mcp`) so it runs the installed CLI from then on; restart the agent afterwards. `nifra upgrade --write` now refuses while a `link:` or `file:` dependency installs another nifra version, naming the commands for that repository; `--allow-linked-skew` proceeds anyway.",
  ],
}

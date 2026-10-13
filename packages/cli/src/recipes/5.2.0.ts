import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.2.
 *
 * No import or dependency moves. Two changes alter what a 5.1 app serves; each note says what changes
 * and what keeps the old answer.
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
  ],
}

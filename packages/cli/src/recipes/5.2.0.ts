import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.2.
 *
 * No import or dependency moves. Six changes alter what a 5.1 app serves or builds, and the development audit,
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
    "An `authenticate()` stage that throws, or returns a malformed decision, still answers 503 `auth_unavailable`, but its cause now goes to `onError` (a response it returns replaces the 503) and, when no hook answers, to the logger as `unhandled request error`. A stage that throws a `Response` or `status(...)`, such as `requirePrincipal`'s 401 or redirect, now has it sent as thrown instead of a 503, and `authed()` from `@nifrajs/better-auth` no longer catches provider failures itself. An `onError` hook that answers every error now answers these too; return nothing for them to keep the 503.",
    'The development `unusedScopedHooks` audit also reports a hook only `merge()`d routes follow (a merged route keeps its own server\'s chain), an `authenticate()` after the last route, and a `responseContract()` or `effectLedger()` installed after routes it would have covered. With `unusedScopedHooks: "error"` each now throws at startup outside production: move the call before the routes, or wire the hook on the merged server.',
    "`nifra check` adds NF-C043 (warning): a parent's `authenticate()` or authenticated scope precedes a `merge()` of a server that authenticates none of its routes. Wire the auth on that server, or mark the merge `// nifra-expect NF-C043: <reason>`.",
    "`nifra check`'s capability walk also starts from the module that registered each route, recorded while `nifra.assurance.ts` loads the app, so a route it could not see before (a computed path, a helper-built server) is now checked and may report an undeclared capability.",
    "`nifra check`'s NF-C035 also reads app modules that call `createWebApp` themselves: a call that mounts `api` with no `apiPrefix`, or with one other than the framework config's, is reported. Import the `apiPrefix` from `backend/framework.ts` so both read one value.",
    '`nifra i18n check` and `checkCatalogs()` report two new errors: `latin-share`, a message in a locale that does not write in Latin whose words are mostly Latin script, and `volume`, a long default message translated to under a third of its length. List kept brand names in `latinWords`, raise `maxLatinShare` or lower `minVolumeRatio`, or list the keys under `ignore` (`"*"` for every key) to keep the old answer.',
    "`alternates()` from `@nifrajs/i18n/routing` given `locales` of a single locale returns no links, where it returned one self-reference.",
    '`nifra check` typechecks every project `tsconfig.json` references, each as its own program, where it ran `tsc -p tsconfig.json` alone: a solution-style tsconfig (`"files": []` plus `references`) used to pass having read nothing, and its projects\' errors now fail the check. Name other configs to typecheck in `nifra.check.json` as `"tsconfigs": [...]`.',
    "The Bun build (`nifra build` without `--vite`, `buildClient`, `buildServer`, `nifra dev --bun`) expands `import.meta.glob` as Vite does. A glob it used to bundle as a call that loads nothing now ships its files, and one it cannot read (a computed pattern, an alias, the `query` option) fails the build naming the file and line: write it as a literal, or build with `--vite`.",
    "With both `nifra.config.ts` and `backend/framework.ts`, `nifra dev` and `nifra build` take `publicEnvPrefix` from `backend/framework.ts` when `nifra.config.ts` leaves it unset, so browser code reads the variables under that prefix there too, and `nifra check` (NF-C029) reads `nifra.config.ts` first. Set the prefix in one file to keep a single value.",
    "In a project that declares `@nifrajs/cli`, `nifra upgrade --write` drops the version pin from the MCP launch (`bunx @nifrajs/cli mcp`) so it runs the installed CLI from then on; restart the agent afterwards. `nifra upgrade --write` now refuses while a `link:` or `file:` dependency installs another nifra version, naming the commands for that repository; `--allow-linked-skew` proceeds anyway.",
  ],
}

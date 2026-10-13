import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.1.
 *
 * No import or dependency moves. Three changes can alter what a 5.0 app serves, so each note says what
 * changes and the one edit that keeps or restores the old answer.
 */
export const recipe: UpgradeRecipe = {
  version: "5.1.0",
  pins: [
    { match: "@nifrajs/", to: "5.1.0" },
    { match: "create-nifra", to: "5.1.0" },
    { match: "nifra", to: "5.1.0" },
  ],
  importMoves: [],
  notes: [
    '`merge()` now recompiles a merged route under the `responseContract()` and `effectLedger()` the server it is merged into installed before the merge, when the route declares a response (or capabilities) and its own server installed neither, as a `group()` route already was. Under `responseContract("enforce")`, a merged route whose payload carries a field its closed `t.object` does not declare now answers 500; declare the field, or install `responseContract("enforce", { extra: "strip" })` to drop it. After installing, `nifra routes --hooks --since .nifra/hooks-before-upgrade.json` lists each route that gained the contract.',
    "A route with a `body` schema refuses a urlencoded, multipart or `text/plain` body whose `Origin` names another site with `403 forbidden_origin`, before reading it. A frontend on another origin that posts forms or `FormData` to the API, or an identity provider's `form_post` callback, needs that origin in the `formOrigins` server option (`@nifrajs/edge` takes it too). JSON bodies are unchanged.",
    "`clientIp: { trustedHops: n }` reads the same `X-Forwarded-For` entry whether or not the adapter saw a socket peer. With no peer (Workers, edge handlers, a unix socket) it used to take the entry one place further left, which the client wrote; with no peer, `trustedHops: 0` is now `undefined`.",
    'New and optional: a route assurance `baseline` rule `{ name: "response-contract", match: { hasResponse: true }, require: [NIFRA_ASSURANCE.RESPONSE_CONTRACT] }` makes `nifra assure` fail a route that declares a response no contract enforces.',
  ],
}

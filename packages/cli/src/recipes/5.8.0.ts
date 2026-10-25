import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.8.
 *
 * No import or dependency moves. On Bun, refusing a Host that Node and Deno refuse becomes the
 * `validateHost` server option; the note says what an app on Bun sees differently.
 */
export const recipe: UpgradeRecipe = {
  version: "5.8.0",
  pins: [
    { match: "@nifrajs/", to: "5.8.0" },
    { match: "create-nifra", to: "5.8.0" },
    { match: "nifra", to: "5.8.0" },
  ],
  importMoves: [],
  affects: ["@nifrajs/core"],
  notes: [
    "On Bun, a request whose Host Node and Deno refuse is served unless the app sets `server({ validateHost: true })`, where it was answered `400 invalid_host`: one sent twice, one no URL can be built on (a space, a byte past ASCII, a port past 65535, an IPv6 literal no parser takes), or a percent-encoded or sub-delimiter one. With the option such a request is refused as before, and an empty Host is refused from the first request a process serves. The check reads the Host on every request, about 6% of a bare route on Bun, so it is off by default. A target with `.` or `..` segments is still checked without it, and Node and Deno refuse these Hosts either way.",
  ],
}

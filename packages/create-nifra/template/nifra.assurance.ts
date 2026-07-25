/**
 * What this app's routes are required to PROVE, checked by `nifra assure` (and level L1 of
 * `nifra levels`). Evidence is collected from the routes themselves - a `body` schema records
 * `body-bounded`, an auth middleware records `authenticated` - so this file states the requirement
 * and the framework reports whether the route actually carries it.
 *
 * The starter rules below are deliberately small and true of THIS app. Grow them as the app grows:
 * once there is auth, add `NIFRA_ASSURANCE.AUTHENTICATED` to `mutation`, and every route that does
 * not carry it fails the check rather than shipping.
 *
 * Rules are first-match-wins, so order matters: put narrow exemptions above the general rule.
 */
import { defineAssuranceConfig, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import { app } from "./src/app.ts"

export default defineAssuranceConfig({
  source: app,
  policy: {
    rules: [
      // Anything that writes must prove who asked. Matched on the DECLARED capability rather than a
      // path, so it still holds when a route moves or a server function is added later - and a server
      // function is a public POST endpoint like any other, so this is what stops one shipping
      // unauthenticated. Add `capabilities: ["db.write"]` to a route and this rule starts applying.
      {
        name: "authenticated-write",
        match: { capabilities: ["db.write"] },
        require: [NIFRA_ASSURANCE.AUTHENTICATED],
      },
      // Anything that changes state must validate its input at the boundary. Adding a POST without a
      // `body` schema fails this - which is the point: the check is what notices, not review.
      {
        name: "mutation",
        match: { methods: ["POST", "PUT", "PATCH", "DELETE"] },
        require: [NIFRA_ASSURANCE.BODY_BOUNDED],
      },
      // Reads carry no requirement yet. When some become private, split this into a public rule and
      // an authenticated one rather than weakening the whole class.
      { name: "read", match: { methods: ["GET"] }, require: [] },
    ],
  },
})

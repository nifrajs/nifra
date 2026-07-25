/**
 * What this app's routes are required to PROVE, checked by `nifra assure` (and level L1 of
 * `nifra levels`). Evidence is collected from the routes themselves - a `body` schema records
 * `body-bounded`, an auth middleware records `authenticated` - so this file states the requirement
 * and the framework reports whether the route actually carries it.
 *
 * Page routes under `routes/` are not classified here; this is the backend contract those pages call.
 *
 * Rules are first-match-wins, so order matters: narrow exemptions go above the general rule, and each
 * one is named and justified. An exemption you have to write down is one a reviewer can argue with;
 * an exemption you get by leaving the rule off is one nobody ever sees.
 */
import { defineAssuranceConfig, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import { backend } from "./backend"

export default defineAssuranceConfig({
  source: backend,
  policy: {
    rules: [
      // The counter increments; it accepts no input at all, so there is no body to bound. Exempted by
      // name so the general rule below stays strict for every mutation that DOES take input.
      { name: "bodyless-mutation", match: { methods: ["POST"], paths: ["/count"] }, require: [] },
      // Anything that writes must prove who asked. Matched on the DECLARED capability rather than a
      // path, so it still holds when a route moves or a server function is added later - and a server
      // function is a public POST endpoint like any other, so this is what stops one shipping
      // unauthenticated. Add `capabilities: ["db.write"]` to a route and this rule starts applying.
      {
        name: "authenticated-write",
        match: { capabilities: ["db.write"] },
        require: [NIFRA_ASSURANCE.AUTHENTICATED],
      },
      // Anything else that changes state must validate its input at the boundary. Adding a POST
      // without a `body` schema fails this - which is the point: the check notices, not review.
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

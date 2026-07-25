/**
 * What this app's routes are required to PROVE, checked by `nifra assure` (and level L1 of
 * `nifra levels`). Evidence is collected from the routes themselves - a `body` schema records
 * `body-bounded`, an auth middleware records `authenticated` - so this file states the requirement
 * and the framework reports whether the route actually carries it.
 *
 * Rules are first-match-wins, so order matters: narrow exemptions go above the general rule, and each
 * one is named and justified. An exemption you have to write down is one a reviewer can argue with;
 * an exemption you get by leaving the rule off is one nobody ever sees.
 */
import { defineAssuranceConfig, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import { app } from "./src/app.ts"

export default defineAssuranceConfig({
  source: app,
  policy: {
    rules: [
      // The attachment upload takes raw bytes, not a JSON document, so there is no value schema to
      // bound it with - it is guarded by the storage layer's own size limit instead. Exempted by name
      // so the general rule below stays strict for everything else.
      {
        name: "raw-upload",
        match: { methods: ["PUT"], paths: ["/notes/*/attachment"] },
        require: [],
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

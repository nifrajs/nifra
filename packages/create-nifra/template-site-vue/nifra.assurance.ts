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
  // What each effect IS, so the policy below can be written about a CLASS of effect rather than a list
  // of token names: `{ access: "write", zone: "domain" }` covers `payments.charge` the day someone adds
  // it, where a rule naming `db.write` would not. Declaring the tokens here is also what lifts this app
  // to L2 of `nifra levels`.
  capabilities: {
    definitions: [
      { id: "db.read", zone: "domain", access: "read" },
      { id: "db.write", zone: "domain", access: "write" },
    ],
    provenance: {
      // Map a module specifier to the capabilities reaching it implies, and `nifra check` reports any
      // route that can reach further than it declared - so wiring a database into a handler and
      // forgetting to say so becomes a failing check rather than something review has to catch. The
      // seam `--db` scaffolds is already shaped for it, split by access:
      //
      //   { specifier: "./read.ts", capabilities: ["db.read"] },
      //   { specifier: "./write.ts", capabilities: ["db.write"] },
      //   { specifier: "bun:sqlite", capabilities: ["db.read", "db.write"] },
      //
      // Turning it on is a structural commitment, so know the rule first: reach is computed from the
      // module that REGISTERS a route, following its imports. Any module that registers routes and can
      // reach a database gives EVERY route in it that reach - and a GET route may not declare a domain
      // write at all, so those routes have no legal declaration and must move. Every module that
      // registers routes therefore has to be import-disjoint from the effects its routes do not use,
      // and the app root has to be pure composition (`server().merge(home).merge(notes)`) rather than a
      // place routes are declared. Worth it for an app that wants the guarantee; a real commitment.
      imports: [],
      // Add a driver here to force every query through a seam you own, and the check will name any
      // route that reaches around it: `{ specifier: "pg", reason: "query through db/" }`.
      forbiddenImports: [],
    },
  },
  policy: {
    rules: [
      // The counter increments; it accepts no input at all, so there is no body to bound. Exempted by
      // name so the general rule below stays strict for every mutation that DOES take input.
      { name: "bodyless-mutation", match: { methods: ["POST"], paths: ["/count"] }, require: [] },
      // Anything that writes business state must prove who asked. Matched on what the capability IS
      // rather than on its name or its path, so a token introduced later - `payments.charge`,
      // `orders.write` - is covered the day it is declared instead of the day someone remembers to
      // widen this rule. A server function is a public POST endpoint like any other, so this is what
      // stops one shipping unauthenticated.
      {
        name: "authenticated-write",
        match: { access: "write", zone: "domain" },
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

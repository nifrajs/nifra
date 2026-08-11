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
  // it, where a rule naming `db.write` would not.
  capabilities: {
    definitions: [
      { id: "db.read", zone: "domain", access: "read" },
      { id: "db.write", zone: "domain", access: "write" },
    ],
    provenance: {
      // Reaching one of these modules means holding the capabilities beside it, and `nifra check` fails
      // any route that can reach further than it declared - so wiring a database into a handler and
      // forgetting to say so is a failing check rather than something review has to catch.
      //
      // The first two are the seam `--db` scaffolds, split by access on purpose: reach is computed per
      // MODULE, and a GET route may not declare a domain write, so a module that can reach both has GET
      // routes with no legal declaration. Keeping reads and writes import-disjoint - at the seam and at
      // the route modules - is what keeps every route's declaration equal to its reach. The drivers
      // below are the backstop for code that goes around the seam; they grant both, because an import
      // cannot tell a read from a write.
      imports: [
        { specifier: "./read.ts", capabilities: ["db.read"] },
        { specifier: "./write.ts", capabilities: ["db.write"] },
        { specifier: "bun:sqlite", capabilities: ["db.read", "db.write"] },
        { specifier: "node:sqlite", capabilities: ["db.read", "db.write"] },
        { specifier: "pg", capabilities: ["db.read", "db.write"] },
        { specifier: "postgres", capabilities: ["db.read", "db.write"] },
        { specifier: "mysql2", capabilities: ["db.read", "db.write"] },
        { specifier: "kysely", capabilities: ["db.read", "db.write"] },
        { specifier: "drizzle-orm", capabilities: ["db.read", "db.write"] },
        { specifier: "drizzle-orm/*", capabilities: ["db.read", "db.write"] },
        { specifier: "@libsql/*", capabilities: ["db.read", "db.write"] },
        { specifier: "@prisma/client", capabilities: ["db.read", "db.write"] },
      ],
      // Add a driver here to force every query through the seam, and the check will name any route that
      // reaches around it: `{ specifier: "pg", reason: "query through db/read.ts or db/write.ts" }`.
      forbiddenImports: [],
    },
  },
  policy: {
    rules: [
      // Anything that writes business state must prove who asked. Matched on what the capability IS
      // rather than on its name or its path, so a token introduced later - `payments.charge`,
      // `orders.write` - is covered the day it is declared instead of the day someone remembers to
      // widen this rule. A server function is a public POST endpoint like any other, so this is what
      // stops one shipping unauthenticated.
      {
        name: "authenticated-write",
        match: { access: "write", zone: "domain" },
        require: [NIFRA_ASSURANCE.AUTHENTICATED],
        requireProvenance: "runtime",
        requireCsrfWithAuthenticated: true,
      },
      // Anything that changes state must validate its input at the boundary. This demo is read-only,
      // so the rule classifies nothing yet - which is the point: the first POST added to `page.ts`
      // fails the check unless it bounds its body.
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

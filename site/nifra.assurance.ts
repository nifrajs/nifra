/**
 * What this site's backend routes are required to PROVE. Same shape a scaffolded app gets, applied to
 * an app that was written years before the policy existed - which is the point of having it here.
 *
 * Page routes under `routes/` are not classified; this is the backend contract those pages call.
 */
import { defineAssuranceConfig, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import { backend } from "./backend"

export default defineAssuranceConfig({
  source: backend,
  capabilities: {
    definitions: [
      { id: "db.read", zone: "domain", access: "read" },
      { id: "db.write", zone: "domain", access: "write" },
    ],
    provenance: {
      imports: [
        { specifier: "bun:sqlite", capabilities: ["db.read", "db.write"] },
        { specifier: "postgres", capabilities: ["db.read", "db.write"] },
        { specifier: "drizzle-orm", capabilities: ["db.read", "db.write"] },
        { specifier: "drizzle-orm/*", capabilities: ["db.read", "db.write"] },
      ],
      forbiddenImports: [],
    },
  },
  policy: {
    rules: [
      {
        name: "authenticated-write",
        match: { access: "write", zone: "domain" },
        require: [NIFRA_ASSURANCE.AUTHENTICATED],
      },
      // The demo counter takes no input at all, so there is no body to bound. Named rather than
      // silently uncovered, so a reviewer can argue with it.
      { name: "bodyless-counter", match: { methods: ["POST"], paths: ["/count"] }, require: [] },
      {
        name: "mutation",
        match: { methods: ["POST", "PUT", "PATCH", "DELETE"] },
        require: [NIFRA_ASSURANCE.BODY_BOUNDED],
      },
      { name: "read", match: { methods: ["GET"] }, require: [] },
    ],
  },
})

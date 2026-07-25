import { server } from "@nifrajs/core/server"
import { routes } from "./routes.ts"

/** Your app. Exported (without `listen`) so tests can drive it via the in-process test client. */

// Composition only: this module merges route modules and registers none of its own.
//
// That is not a style preference. `nifra check` works out what a route can reach from the module that
// REGISTERS it, following that module's imports - so a file that registers routes AND imports a
// database gives every route in it database reach, and a GET route may not declare a domain write at
// all. Keeping the root pure means each route's reach is its own module's, which is what lets the
// capability declarations in `nifra.assurance.ts` stay true as the app grows. Add a feature as a
// module, merge it here.
export const app = server().merge(routes)

export type App = typeof app

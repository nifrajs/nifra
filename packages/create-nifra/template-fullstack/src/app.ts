import { server } from "@nifrajs/core/server"
import { noteRoutes } from "./notes.ts"

/** Your app. Exported (without `listen`) so tests can drive it via the in-process test client. */

// Composition only: this module merges route modules and registers none of its own.
//
// That is not a style preference. `nifra check` works out what a route can reach from the module that
// REGISTERS it, following that module's imports - so a file that registers routes AND imports a
// database gives every route in it database reach, and a GET route may not declare a domain write at
// all. Keeping the root pure means each route's reach is its own module's, which is what lets the
// capability declarations in `nifra.assurance.ts` stay true as the app grows. Add a feature as a
// module, merge it here.
export const app = server().merge(noteRoutes)

export type App = typeof app

export type { Note } from "./notes.ts"
// Re-exported so `index.ts` can start the worker and `app.test.ts` can inspect it, without either
// needing to know which module the notes feature lives in.
export { queue, wasIndexed } from "./notes.ts"

import { server } from "@nifrajs/core/server"
import {
  cors,
  createAdmissionController,
  MemoryStore,
  rateLimit,
  securityHeaders,
} from "@nifrajs/middleware"
import { page } from "./page"

// Your backend contract - page loaders/actions call it in-process during SSR (no network).
// Name and location are load-bearing: `nifra dev|build|check` resolve `backend.ts` from the project
// root, the same fixed convention as `routes/`, `framework.ts`, and `nifra.config.ts`. Rename or move
// it and the CLI runs without a backend (no error - the file is optional). Only THIS entry file is
// pinned to the root; the modules it merges can live in any directory you like.
//
// Composition only: this module merges route modules and registers none of its own.
//
// That is not a style preference. `nifra check` works out what a route can reach from the module that
// REGISTERS it, following that module's imports - so a file that registers routes AND imports a
// database gives every route in it database reach, and a GET route may not declare a domain write at
// all. Keeping this file pure means each route's reach is its own module's, which is what lets the
// capability declarations in `nifra.assurance.ts` stay true as the app grows. Add a feature as a
// module, merge it here.
const rateStore = new MemoryStore({
  allowInProduction: process.env.NIFRA_ALLOW_MEMORY_RATE_LIMIT === "true",
})

export const backend = server({
  requestTimeoutMs: 30_000,
  admission: createAdmissionController({ maxInFlight: 128, maxQueue: 0 }),
})
  .use(securityHeaders())
  .use(
    cors({
      origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
      credentials: false,
    }),
  )
  .use(rateLimit({ store: rateStore, max: 120, windowMs: 60_000 }))
  .merge(page)

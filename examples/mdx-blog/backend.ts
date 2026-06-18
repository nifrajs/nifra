import { server } from "@nifrajs/core"

/** Minimal backend contract — this demo's data comes from the content collection (in the loaders), so
 * the API only needs a trivial route to satisfy the in-process client. */
export const backend = server().get("/health", () => ({ ok: true }))

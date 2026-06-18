/**
 * Type-level proof for Phase 5's context extension: `derive`/`decorate` extend the
 * handler context for DOWNSTREAM routes, are order-scoped, and compose. Verified
 * by `tsc` (each handler body that reads an extended field is itself the check).
 */
import { server } from "@nifrajs/core"

// decorate (static) + derive (per-request) reach a downstream handler, typed.
export const _downstream = server()
  .decorate("version", "1.0")
  .derive((c) => ({ requestId: c.req.headers.get("x-request-id") ?? "none" }))
  .get("/me", (c) => ({ version: c.version, requestId: c.requestId }))

// order-scoping: a route registered BEFORE the extension does not see it.
export const _ordered = server()
  .get("/early", (c) => {
    // @ts-expect-error `version` is not on the context yet (decorated below)
    const v = c.version
    return { v }
  })
  .decorate("version", "1.0")

// composition: a derive can read a prior decorate, and a later route sees both.
export const _compose = server()
  .decorate("base", 10)
  .derive((c) => ({ doubled: c.base * 2 }))
  .get("/x", (c) => ({ base: c.base, doubled: c.doubled }))

/**
 * PHASE-0 COMPACT KERNEL PROTOTYPE - the real ceiling of the edge bet, defaults included.
 *
 * Where worker-nifra-edge is the naked router (no defaults, a pure floor), this row is the shape a
 * shipping compact edge entrypoint would actually take: nifra's REAL router plus the MUST-KEEP
 * secure-by-default surface an edge handler cannot honestly drop -
 *
 *   - bounded body read + Content-Length pre-reject (400 malformed / 413 too large)  body.ts
 *   - prototype-pollution guard on the parsed JSON (reject policy)                    proto-guard.ts
 *   - Standard Schema validation of the body at the trust boundary (inline)
 *   - structured JSON error envelope on every rejection (inline)
 *
 * It DROPS the opt-in lanes that are not per-request edge defaults: deadline, assurance, capability,
 * idempotency, effect ledger, mcp, sse, ws, the full lifecycle pipeline, cookies, response tagging.
 * Those are exactly the INSTALL_* seams a lane-registry refactor would keep behind opt-in.
 *
 * Composed from core's real primitives (free functions, not a `Server` instance), so the bundle is
 * a FAITHFUL lower bound on what that refactor could ship WITH the moat intact - not the naked-router
 * floor of the spike, and not the full 26 KB Server. It imports the SAME `@nifrajs/core/router` as the
 * spike row, so the delta between the two rows is exactly what the must-keep defaults cost.
 *
 * Still a prototype, not a shipping entrypoint: it hand-wires dispatch that a real kernel would move
 * behind a reduced-lane `server()` overload. Its job is to answer "does the moat fit under hono's
 * cold time?" before the refactor is committed. Semantics match every other row (GET /users/:id,
 * POST /users with the shared `isUser` predicate) so compile/init/first-request stay apples to apples.
 */

import { Router } from "@nifrajs/core/router"
import { readBoundedBytes } from "../../packages/core/src/server/body.ts"
import { parseJsonGuarded } from "../../packages/core/src/server/proto-guard.ts"
import { queryObjectOf, searchOf } from "../../packages/core/src/server/query.ts"
import { isUser } from "./_fixtures.ts"

/** Default request-body cap. A real kernel would take this per-route; a shipping edge default is 1 MB. */
const MAX_BODY_BYTES = 1024 * 1024

/** Minimal Standard Schema v1 surface - the validate contract the kernel calls at the boundary. */
interface StandardResult {
  readonly value?: unknown
  readonly issues?: readonly unknown[]
}
interface StandardSchema {
  readonly ["~standard"]: {
    validate(value: unknown): StandardResult | Promise<StandardResult>
  }
}

/** The POST /users body schema, wrapping the shared predicate in a real Standard Schema validate(). */
const userSchema: StandardSchema = {
  "~standard": {
    validate: (value) => (isUser(value) ? { value } : { issues: [{ message: "invalid user" }] }),
  },
}

/** Structured error envelope - every rejection leaves through here, never a bare string. */
const errorResponse = (status: number, message: string): Response =>
  Response.json({ error: { status, message } }, { status })

type KernelCtx = {
  readonly request: Request
  readonly params: Record<string, string>
  query(): Record<string, string | string[]>
}
type KernelHandler = (ctx: KernelCtx) => Response | Promise<Response>

const router = new Router<KernelHandler>()

router.add("GET", "/users/:id", (ctx) => Response.json({ id: ctx.params.id }))

router.add("POST", "/users", async (ctx) => {
  // 1. bounded read - a lying/oversized Content-Length is rejected before the body is drained.
  const bounded = await readBoundedBytes(ctx.request, MAX_BODY_BYTES)
  if (!bounded.ok) {
    return errorResponse(
      bounded.status,
      bounded.status === 413 ? "payload too large" : "malformed body",
    )
  }
  // 2. proto-guarded parse - poisoned JSON is indistinguishable from malformed JSON to the caller.
  let parsed: unknown
  try {
    parsed = parseJsonGuarded(new TextDecoder().decode(bounded.bytes), "reject")
  } catch {
    return errorResponse(400, "invalid json")
  }
  // 3. schema validation at the boundary - parse, don't cast.
  const result = await userSchema["~standard"].validate(parsed)
  if (result.issues !== undefined || result.value === undefined) {
    return errorResponse(422, "validation failed")
  }
  const body = result.value as { readonly name: string }
  return Response.json({ id: "1", name: body.name })
})

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const match = router.find(request.method, url.pathname)
    if (!match.found) return errorResponse(404, "not found")
    try {
      return await match.payload({
        request,
        params: match.params,
        query: () => queryObjectOf(searchOf(request.url)),
      })
    } catch {
      return errorResponse(500, "internal error")
    }
  },
}

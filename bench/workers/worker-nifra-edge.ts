/**
 * SPIKE ROW - not a shipping profile. The FLOOR a compact nifra edge kernel could reach.
 *
 * This uses nifra's REAL router (`@nifrajs/core/router`, the trie nifra is proud of) with a
 * hand-minimal dispatch and JSON response, and NOTHING of the `Server` class: no lifecycle pipeline,
 * no per-route body cap, no deadline/assurance/capability/proto-guard/structured-error surface. So
 * read this row as an UPPER BOUND on the savings a lane-registry refactor could deliver, and a LOWER
 * BOUND on its cold time - a real compact kernel keeps some of those defaults and lands heavier than
 * this. Its only job is to answer "is the ceiling of the edge bet worth chasing?" before the refactor.
 *
 * Semantics match the other rows (GET /users/:id, POST /users with the shared `isUser` predicate) so
 * the compile/init/first-request comparison is apples to apples.
 */

import { Router } from "@nifrajs/core/router"
import { isUser } from "./_fixtures.ts"

type EdgeHandler = (request: Request, params: Record<string, string>) => unknown | Promise<unknown>

const router = new Router<EdgeHandler>()
router.add("GET", "/users/:id", (_request, params) => ({ id: params.id }))
router.add("POST", "/users", async (request) => {
  const body: unknown = await request.json()
  return isUser(body)
    ? { id: "1", name: body.name }
    : new Response(JSON.stringify({ error: "invalid" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
})

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const match = router.find(request.method, url.pathname)
    if (!match.found) return new Response("not found", { status: 404 })
    const out = await match.payload(request, match.params)
    return out instanceof Response ? out : Response.json(out)
  },
}

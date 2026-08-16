/**
 * The floor row: a hand-written `fetch` handler with no framework. Its parse+init cost is this box's
 * V8 baseline for a single-file Worker; the interesting number for nifra or hono is its DISTANCE from
 * this row, not the absolute (which still contains the harness's own context setup).
 */

import { isUser } from "./_fixtures.ts"

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname.startsWith("/users/")) {
      return Response.json({ id: url.pathname.slice("/users/".length) })
    }
    if (request.method === "POST" && url.pathname === "/users") {
      // The raw row still validates identical semantics; it just has no framework plumbing.
      return request
        .json()
        .then((body) =>
          isUser(body)
            ? Response.json({ id: "1", name: body.name })
            : Response.json({ error: "invalid" }, { status: 400 }),
        ) as unknown as Response
    }
    return new Response("not found", { status: 404 })
  },
}

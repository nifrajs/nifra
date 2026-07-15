/**
 * nifra on the edge / non-Bun runtimes.
 *
 * `app.fetch` is a pure `(Request) => Promise<Response>` — the Web-standard handler
 * shape — and uses ZERO Bun APIs. So it *is* the entrypoint everywhere; only
 * `app.listen()` is Bun-specific. Hand `app.fetch` to whatever runtime you deploy on:
 *
 *   Bun:                 app.listen(3000)
 *   Cloudflare Workers:  export default app                 // Bun auto-serves this shape too
 *   Deno:                Deno.serve((req) => app.fetch(req))   // or @nifrajs/deno for a graceful stop()
 *   Node:                serve(app, { port }) from @nifrajs/node  (see examples/serve-on-node.ts)
 *
 *   bun run examples/edge.ts
 */
import { server } from "@nifrajs/core/server"
import { cors } from "@nifrajs/middleware"
import { t } from "@nifrajs/schema"

const app = server()
  .use(cors())
  .get("/", () => ({ runtime: "any fetch-compatible runtime" }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => ({
    id: "u1",
    name: c.body.name,
  }))

// Proof: invoke `app.fetch` exactly as Workers / Deno would call your handler — no
// Bun, no `listen`, no port. (The 8f clean-dir smoke runs this same path under Node.)
const res = await app.fetch(
  new Request("http://edge/users", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example.com" },
    body: JSON.stringify({ name: "Ada" }),
  }),
)
console.log("app.fetch →", res.status, "| CORS:", res.headers.get("access-control-allow-origin"))
console.log("body →", await res.json()) // { id: "u1", name: "Ada" }

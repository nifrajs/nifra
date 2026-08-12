import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

export const hydrate = false

export const meta = docsMeta(
  "/docs/migrate-route-by-route",
  "Nifra - Migrate route by route",
  "Keep an existing Hono, Elysia, Express, or Workers app running while moving routes into typed Nifra handlers one at a time.",
)

const HONO = `import { Hono } from "hono"
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

const legacy = new Hono()
legacy.get("/users", (c) => c.json({ source: "hono", users: [] }))
legacy.post("/users", async (c) => c.json(await c.req.json()))

export const app = server()
  // The wildcard is a literal mount prefix, not a typed Nifra route.
  .mountFetch("/legacy/*", legacy.fetch, { stripPrefix: true })
  // Typed routes take precedence, so move one route out of Hono at a time.
  .get("/legacy/users/:id", (c) => ({ id: c.params.id, source: "nifra" }))
  .post(
    "/users",
    { body: t.object({ name: t.string() }) },
    (c) => ({ id: crypto.randomUUID(), name: c.body.name }),
  )`

export default function MigrateRouteByRoute() {
  return (
    <div className="prose">
      <h1 className="page">Migrate route by route</h1>
      <p className="lead">
        Keep the old app live while you move its surface into Nifra. Mount the legacy fetch handler at
        a prefix, add typed Nifra routes as they are ready, then delete the mount when the prefix is
        empty.
      </p>

      <blockquote>
        [!WARNING] Mounted handlers are an escape hatch. Their request and response shapes are outside
        Nifra's typed route contract, response schemas, and response-contract enforcement. Keep the
        mount small and temporary, and use typed routes for every migrated endpoint.
      </blockquote>

      <h2>1. Mount the existing app</h2>
      <p>
        <code>mountFetch</code> accepts any handler with the Web fetch shape. Use a path ending in{" "}
        <code>/*</code> for a subtree. By default the legacy app sees the original URL. Set{" "}
        <code>stripPrefix: true</code> when the legacy app declares paths relative to its mount point.
        The platform object is forwarded as the second argument when the runtime supplies one.
      </p>
      <CodeBlock code={HONO} lang="ts" />

      <h2>2. Move the routes</h2>
      <ol>
        <li>Choose one legacy endpoint and add it as a typed Nifra route.</li>
        <li>Keep the mount in place for the remaining endpoints.</li>
        <li>Add a body, query, or params schema so the trust boundary is explicit.</li>
        <li>Run <code>nifra check</code> and the route tests, then repeat.</li>
      </ol>
      <p>
        Typed routes win when both surfaces match. That lets a new Nifra route replace its legacy
        counterpart without changing the mount prefix or adding a second server.
      </p>

      <h2>3. Remove the escape hatch</h2>
      <p>
        When the legacy prefix has no remaining routes, remove <code>mountFetch</code> and delete the
        old app. The remaining routes now have typed params, validated inputs, reflected contracts,
        and the end-to-end typed client.
      </p>

      <h2>Other legacy handlers</h2>
      <p>
        The same seam works with Elysia, an Express app exposed through an adapter, or a raw Workers
        handler. Pass its fetch-compatible function directly. For a Workers-style handler, the
        platform argument carries bindings and <code>waitUntil</code>; mounted code remains responsible
        for its own framework-specific request and response conventions.
      </p>
    </div>
  )
}

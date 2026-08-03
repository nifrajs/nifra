/**
 * Per-framework benchmark server, selected by CLI arg, serving IDENTICAL routes
 * so the HTTP throughput comparison is apples-to-apples. Each runs in its own
 * subprocess (spawned by run.ts), isolated from the oha load client.
 *
 * Routes (identical across every framework):
 *   GET  /            → { hello: "world" }   (routing + JSON serialization)
 *   GET  /users/:id   → { id }               (path-param extraction)
 *   GET  /search      → validate query, return { q, limit }
 *   POST /users       → validate { name: string; age: number }, return { id, name }
 *
 * The POST row uses each framework's *idiomatic* validation - nifra: a Standard
 * Schema; Elysia: TypeBox (`t`); Hono: the built-in `validator`; raw rows: a manual
 * type guard. So that row measures real-world body-parse + validation cost, not
 * pure routing. (Reported as such in BENCHMARKS.md.)
 *
 *   bun run bench/http/serve.ts <nifra|hono|elysia|bun-native> <port>
 */
const framework = process.argv[2]
const port = Number(process.argv[3])

if (!Number.isInteger(port)) {
  throw new Error(
    "usage: bun run bench/http/serve.ts <nifra|hono|elysia|bun-native> <port>",
  )
}

/**
 * The one validation predicate every framework's POST /users branch shares, so
 * the *semantics* validated are identical and only the framework's plumbing
 * (its validation hook) differs. After `typeof v === "object" && v !== null`,
 * `"k" in v` narrows `v` to carry `k: unknown` - no casts needed.
 */
function isUser(v: unknown): v is { name: string; age: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    "name" in v &&
    typeof v.name === "string" &&
    "age" in v &&
    typeof v.age === "number"
  )
}

function isSearch(v: unknown): v is { q: string; limit: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "q" in v &&
    typeof v.q === "string" &&
    "limit" in v &&
    typeof v.limit === "string"
  )
}


if (framework === "nifra") {
  // Shared with the Node nifra row (serve-node-nifra.ts) so both sections measure the
  // identical app - no drift between runtimes.
  const { makeNifraApp } = await import("./_nifra-app.ts")
  makeNifraApp().listen(port)
} else if (framework === "hono") {
  const { Hono } = await import("hono")
  const { validator } = await import("hono/validator")
  const app = new Hono()
    .get("/", (c) => c.json({ hello: "world" }))
    .get("/users/:id", (c) => c.json({ id: c.req.param("id") }))
    .get(
      "/search",
      validator("query", (value, c) =>
        isSearch(value) ? value : c.json({ error: "invalid" }, 400),
      ),
      (c) => c.json({ q: c.req.valid("query").q, limit: c.req.valid("query").limit }),
    )
    .post(
      "/users",
      // Hono's built-in validator - its idiomatic, dependency-free validation hook.
      validator("json", (value, c) => (isUser(value) ? value : c.json({ error: "invalid" }, 400))),
      (c) => c.json({ id: "1", name: c.req.valid("json").name }),
    )
  Bun.serve({ port, fetch: app.fetch })
} else if (framework === "elysia") {
  const { Elysia, t } = await import("elysia")
  new Elysia()
    .get("/", () => ({ hello: "world" }))
    .get("/users/:id", ({ params }) => ({ id: params.id }))
    .get("/search", ({ query }) => ({ q: query.q, limit: query.limit }), {
      query: t.Object({ q: t.String(), limit: t.String() }),
    })
    // Elysia's idiomatic validation: TypeBox, compiled to a fast check.
    .post("/users", ({ body }) => ({ id: "1", name: body.name }), {
      body: t.Object({ name: t.String(), age: t.Number() }),
    })
    .listen(port)
} else if (framework === "bun-native") {
  // The Bun routing ceiling: the compiled `routes` table is the platform primitive optimized
  // Bun frameworks build on.
  Bun.serve({
    port,
    routes: {
      "/": { GET: () => Response.json({ hello: "world" }) },
      "/users/:id": {
        GET: (req) => Response.json({ id: req.params.id }),
      },
      "/search": {
        GET: (req) => {
          const url = new URL(req.url)
          const q = url.searchParams.get("q")
          const limit = url.searchParams.get("limit")
          return q !== null && limit !== null
            ? Response.json({ q, limit })
            : new Response("invalid", { status: 400 })
        },
      },
      "/users": {
        POST: async (req) => {
          const body: unknown = await req.json().catch(() => undefined)
          return isUser(body)
            ? Response.json({ id: "1", name: body.name })
            : new Response("invalid", { status: 400 })
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  })
} else {
  throw new Error(`unknown framework: ${framework ?? "(none)"}`)
}

export {}

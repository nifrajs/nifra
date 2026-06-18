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
 * The POST row uses each framework's *idiomatic* validation — nifra: a Standard
 * Schema; Elysia: TypeBox (`t`); Hono: the built-in `validator`; bun-raw: a manual
 * type guard. So that row measures real-world body-parse + validation cost, not
 * pure routing. (Reported as such in BENCHMARKS.md.)
 *
 *   bun run bench/http/serve.ts <nifra|hono|elysia|bun-raw> <port>
 */
const framework = process.argv[2]
const port = Number(process.argv[3])

if (!Number.isInteger(port)) {
  throw new Error("usage: bun run bench/http/serve.ts <nifra|hono|elysia|bun-raw> <port>")
}

/**
 * The one validation predicate every framework's POST /users branch shares, so
 * the *semantics* validated are identical and only the framework's plumbing
 * (its validation hook) differs. After `typeof v === "object" && v !== null`,
 * `"k" in v` narrows `v` to carry `k: unknown` — no casts needed.
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

// Manual pathname scan — the same trick nifra (urlPartsOf) and deno-raw use, so the raw ceiling
// isn't handicapped by a full `new URL()` parse on every request. (Kept in sync with serve-deno.ts.)
function pathnameOf(url: string): string {
  const schemeEnd = url.indexOf("://")
  const start = schemeEnd === -1 ? url.indexOf("/") : url.indexOf("/", schemeEnd + 3)
  if (start === -1) return "/"
  let end = url.length
  for (let i = start; i < end; i++) {
    const c = url.charCodeAt(i)
    if (c === 63 /* ? */ || c === 35 /* # */) {
      end = i
      break
    }
  }
  return url.slice(start, end)
}

if (framework === "nifra") {
  // Shared with the Node nifra row (serve-node-nifra.ts) so both sections measure the
  // identical app — no drift between runtimes.
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
      // Hono's built-in validator — its idiomatic, dependency-free validation hook.
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
} else if (framework === "bun-raw") {
  // The Bun ceiling: hand-routed `Bun.serve`, manual parse + validate. Does the
  // least work any server could — the baseline nifra's overhead is measured against.
  const usersPrefix = "/users/"
  Bun.serve({
    port,
    async fetch(req) {
      const pathname = pathnameOf(req.url)
      if (req.method === "GET") {
        if (pathname === "/") return Response.json({ hello: "world" })
        if (pathname.startsWith(usersPrefix)) {
          return Response.json({ id: pathname.slice(usersPrefix.length) })
        }
        if (pathname === "/search") {
          const url = new URL(req.url)
          const q = url.searchParams.get("q")
          const limit = url.searchParams.get("limit")
          if (q !== null && limit !== null) return Response.json({ q, limit })
          return new Response("invalid", { status: 400 })
        }
      } else if (req.method === "POST" && pathname === "/users") {
        const body: unknown = await req.json().catch(() => undefined)
        if (isUser(body)) return Response.json({ id: "1", name: body.name })
        return new Response("invalid", { status: 400 })
      }
      return new Response("not found", { status: 404 })
    },
  })
} else {
  throw new Error(`unknown framework: ${framework ?? "(none)"}`)
}

export {}

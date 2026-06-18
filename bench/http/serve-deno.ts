/**
 * Per-framework benchmark server for the DENO section, selected by CLI arg, serving
 * the IDENTICAL routes to the Bun/Node sections.
 *
 * Routes:
 *   GET  /            -> { hello: "world" }
 *   GET  /users/:id   -> { id }
 *   GET  /search      -> validate query, return { q, limit }
 *   POST /users       -> validate { name: string; age: number }, return { id, name }
 *
 * Run by Deno (offline, from local source paths), spawned by run.ts:
 *
 *   deno run --allow-net --allow-env --no-check bench/http/serve-deno.ts <nifra|hono|elysia|deno-raw> <port>
 */
import { Hono } from "hono"
import { validator } from "hono/validator"
import type {
  StandardResult,
  StandardSchemaV1,
  StandardTypes,
} from "../../packages/core/src/index.ts"
import { server } from "../../packages/core/src/index.ts"
import { serve } from "../../packages/deno/src/index.ts"

const framework = Deno.args[0]
const port = Number(Deno.args[1])

if (!Number.isInteger(port)) {
  throw new Error(
    "usage: deno run --allow-net --allow-env --no-check bench/http/serve-deno.ts <nifra|hono|elysia|deno-raw> <port>",
  )
}

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

const userBody: StandardSchemaV1<unknown, { name: string; age: number }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ name: string; age: number }> {
      return isUser(value)
        ? { value }
        : { issues: [{ message: "expected { name: string; age: number }" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, { name: string; age: number }>,
  },
}

const searchQuery: StandardSchemaV1<unknown, { q: string; limit: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ q: string; limit: string }> {
      return isSearch(value)
        ? { value }
        : { issues: [{ message: "expected ?q=string&limit=string" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, { q: string; limit: string }>,
  },
}

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
  await serve(
    server()
      .get("/", () => ({ hello: "world" }))
      .get("/users/:id", (c) => ({ id: c.params.id }))
      .get("/search", { query: searchQuery }, (c) => ({ q: c.query.q, limit: c.query.limit }))
      .post("/users", { body: userBody }, (c) => ({ id: "1", name: c.body.name })),
    { port },
  )
} else if (framework === "hono") {
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
      validator("json", (value, c) => (isUser(value) ? value : c.json({ error: "invalid" }, 400))),
      (c) => c.json({ id: "1", name: c.req.valid("json").name }),
    )
  Deno.serve({ port, onListen() {} }, app.fetch)
} else if (framework === "elysia") {
  // Elysia on Deno via its Web-Standard adapter → Deno.serve(app.fetch). IDENTICAL routes + TypeBox
  // validation to the Bun/Node servers, so a cross-runtime delta is Elysia's own, not the bench's.
  const { Elysia, t } = await import("elysia")
  const { WebStandardAdapter } = await import("elysia/adapter/web-standard")
  const app = new Elysia({ adapter: WebStandardAdapter })
    .get("/", () => ({ hello: "world" }))
    .get("/users/:id", ({ params }) => ({ id: params.id }))
    .get("/search", ({ query }) => ({ q: query.q, limit: query.limit }), {
      query: t.Object({ q: t.String(), limit: t.String() }),
    })
    .post("/users", ({ body }) => ({ id: "1", name: body.name }), {
      body: t.Object({ name: t.String(), age: t.Number() }),
    })
  Deno.serve({ port, onListen() {} }, app.fetch)
} else if (framework === "deno-raw") {
  const usersPrefix = "/users/"
  Deno.serve(
    {
      port,
      onListen() {},
    },
    async (req) => {
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
  )
} else {
  throw new Error(`unknown framework: ${framework ?? "(none)"}`)
}

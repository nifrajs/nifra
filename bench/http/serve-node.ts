/**
 * Per-framework benchmark server for the NODE section, selected by CLI arg, serving
 * the IDENTICAL routes to serve.ts (the Bun section) so the comparison is fair across
 * runtimes. Run by Node (v24 strips TS types natively — no build step), spawned as an
 * isolated subprocess by run.ts.
 *
 * Routes (identical to the Bun servers):
 *   GET  /            → { hello: "world" }
 *   GET  /users/:id   → { id }
 *   GET  /search      → validate query, return { q, limit }
 *   POST /users       → validate { name: string; age: number }, return { id, name }
 *
 * Each framework's idiomatic validation — Fastify: JSON-Schema (its built-in, compiled
 * validator); Hono: its built-in validator; Express: `express.json()` + a manual guard;
 * node-raw: manual parse + guard. (Reported as such in BENCHMARKS.md.)
 *
 *   node bench/http/serve-node.ts <fastify|hono|express|elysia|node-raw> <port>
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer } from "node:http"
import { Readable } from "node:stream"

const framework = process.argv[2]
const port = Number(process.argv[3])

if (!Number.isInteger(port)) {
  throw new Error(
    "usage: node bench/http/serve-node.ts <fastify|hono|express|elysia|node-raw> <port>",
  )
}

// Duplicated (not imported) so this file stays independently runnable under Node.
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

if (framework === "fastify") {
  const { default: Fastify } = await import("fastify")
  const app = Fastify()
  app.get("/", () => ({ hello: "world" }))
  // Route generics type params/body without casts.
  app.get<{ Params: { id: string } }>("/users/:id", (req) => ({ id: req.params.id }))
  app.get<{ Querystring: { q: string; limit: string } }>(
    "/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q", "limit"],
          additionalProperties: false,
          properties: { q: { type: "string" }, limit: { type: "string" } },
        },
      },
    },
    (req) => ({ q: req.query.q, limit: req.query.limit }),
  )
  app.post<{ Body: { name: string; age: number } }>(
    "/users",
    {
      // Fastify's idiomatic validation: a JSON Schema, compiled to a fast validator.
      schema: {
        body: {
          type: "object",
          required: ["name", "age"],
          additionalProperties: false,
          properties: { name: { type: "string" }, age: { type: "number" } },
        },
      },
    },
    (req) => ({ id: "1", name: req.body.name }),
  )
  await app.listen({ port })
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
      validator("json", (value, c) => (isUser(value) ? value : c.json({ error: "invalid" }, 400))),
      (c) => c.json({ id: "1", name: c.req.valid("json").name }),
    )
  createServer((req, res) => {
    const response = app.fetch(toWebRequest(req))
    void Promise.resolve(response).then(
      (settled) => writeWebResponse(settled, res),
      () => sendJson(res, 500, { error: "internal" }),
    )
  }).listen(port)
} else if (framework === "express") {
  const { default: express } = await import("express")
  const app = express()
  app.use(express.json())
  app.get("/", (_req, res) => {
    res.json({ hello: "world" })
  })
  app.get("/users/:id", (req, res) => {
    res.json({ id: req.params.id })
  })
  app.get("/search", (req, res) => {
    const query: unknown = req.query
    if (isSearch(query)) {
      res.json({ q: query.q, limit: query.limit })
      return
    }
    res.status(400).json({ error: "invalid" })
  })
  app.post("/users", (req, res) => {
    // Express ships no validator; the idiomatic minimal path is express.json() + a guard.
    const body: unknown = req.body
    if (isUser(body)) {
      res.json({ id: "1", name: body.name })
      return
    }
    res.status(400).json({ error: "invalid" })
  })
  app.listen(port)
} else if (framework === "elysia") {
  // Elysia on Node via its official adapter — IDENTICAL routes + TypeBox validation to the Bun
  // server (only `{ adapter: node() }` changes), so a Bun-vs-Node delta is Elysia's own, not ours.
  const { Elysia, t } = await import("elysia")
  const { node } = await import("@elysiajs/node")
  new Elysia({ adapter: node() })
    .get("/", () => ({ hello: "world" }))
    .get("/users/:id", ({ params }) => ({ id: params.id }))
    .get("/search", ({ query }) => ({ q: query.q, limit: query.limit }), {
      query: t.Object({ q: t.String(), limit: t.String() }),
    })
    .post("/users", ({ body }) => ({ id: "1", name: body.name }), {
      body: t.Object({ name: t.String(), age: t.Number() }),
    })
    .listen(port)
} else if (framework === "node-raw") {
  // The Node ceiling: node:http, manual routing + body parse + validate.
  const usersPrefix = "/users/"
  const server = createServer((req, res) => {
    const url = req.url ?? "/"
    if (req.method === "GET") {
      if (url === "/") return sendJson(res, 200, { hello: "world" })
      if (url.startsWith(usersPrefix)) {
        return sendJson(res, 200, { id: url.slice(usersPrefix.length) })
      }
      if (url.startsWith("/search?")) {
        const search = new URL(url, "http://localhost")
        const q = search.searchParams.get("q")
        const limit = search.searchParams.get("limit")
        if (q !== null && limit !== null) return sendJson(res, 200, { q, limit })
        return sendJson(res, 400, { error: "invalid" })
      }
    } else if (req.method === "POST" && url === "/users") {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch {
          return sendJson(res, 400, { error: "bad_json" })
        }
        if (isUser(parsed)) return sendJson(res, 200, { id: "1", name: parsed.name })
        sendJson(res, 400, { error: "invalid" })
      })
      return
    }
    sendJson(res, 404, { error: "not_found" })
  })
  server.listen(port)
} else {
  throw new Error(`unknown framework: ${framework ?? "(none)"}`)
}

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost"
  const url = `http://${host}${req.url ?? "/"}`
  const method = req.method ?? "GET"
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(", ") : value)
  }
  const init: RequestInit & { duplex?: "half" } = { method, headers }
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>
    init.duplex = "half"
  }
  return new Request(url, init)
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  const setCookies = response.headers.getSetCookie?.()
  if (setCookies !== undefined && setCookies.length > 0) headers["set-cookie"] = setCookies
  res.writeHead(response.status, headers)
  if (response.body !== null) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  }
  res.end()
}

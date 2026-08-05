/**
 * Per-framework REALISTIC-shape benchmark server - the Node section. Mirrors bench/http/serve-node.ts;
 * same route work as serve.ts (Bun section) - security headers, CORS, request-id, bearer auth, cookie
 * read, validated query/body, ~2.4 KB response - so the comparison is fair across runtimes too.
 *
 *   node bench/http-realworld/serve-node.ts <fastify|hono|express|elysia|node-raw> <port>
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer } from "node:http"
import { Readable } from "node:stream"

const framework = process.argv[2]
const port = Number(process.argv[3])

if (!Number.isInteger(port)) {
  throw new Error(
    "usage: node bench/http-realworld/serve-node.ts <fastify|hono|express|elysia|node-raw> <port>",
  )
}

const ORDERS = Array.from({ length: 25 }, (_, i) => ({
  id: `ord_${1000 + i}`,
  sku: `SKU-${i % 7}`,
  qty: (i % 5) + 1,
  pricePaise: 49900 + i * 1375,
  status: i % 3 === 0 ? "shipped" : "pending",
  placedAt: "2026-06-01T10:00:00.000Z",
}))

function isOrderBody(v: unknown): v is { sku: string; qty: number; note: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "sku" in v &&
    typeof v.sku === "string" &&
    "qty" in v &&
    typeof v.qty === "number" &&
    "note" in v &&
    typeof v.note === "string"
  )
}

const SEC: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=15552000; includeSubDomains",
  "access-control-allow-origin": "https://app.example.com",
  "access-control-allow-credentials": "true",
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function authOf(
  authHeader: string | undefined,
  cookieHeader: string | undefined,
): { userId: string; theme: string } | undefined {
  if (authHeader === undefined || !authHeader.startsWith("Bearer ") || authHeader.length < 24) {
    return undefined
  }
  return { userId: authHeader.slice(7, 19), theme: readCookie(cookieHeader, "theme") ?? "light" }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): void {
  res.writeHead(status, { "content-type": "application/json", ...SEC, ...extra })
  res.end(JSON.stringify(body))
}

if (framework === "fastify") {
  const { default: Fastify } = await import("fastify")
  const app = Fastify()
  app.addHook("onSend", async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SEC)) reply.header(k, v)
    reply.header("x-request-id", req.headers["x-request-id"] ?? crypto.randomUUID())
    return payload
  })
  app.addHook("preHandler", async (req, reply) => {
    const who = authOf(req.headers.authorization, req.headers.cookie)
    if (who === undefined) {
      reply.code(401).send({ ok: false, error: "unauthorized" })
      return
    }
    ;(req as unknown as { who: typeof who }).who = who
  })
  app.get<{ Querystring: { limit: string } }>(
    "/api/orders",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["limit"],
          properties: { limit: { type: "string" } },
        },
      },
    },
    (req) => {
      const who = (req as unknown as { who: { userId: string; theme: string } }).who
      return {
        user: who.userId,
        theme: who.theme,
        orders: ORDERS.slice(0, Number(req.query.limit) || 10),
        total: ORDERS.length,
      }
    },
  )
  app.post<{ Body: { sku: string; qty: number; note: string } }>(
    "/api/orders",
    {
      schema: {
        body: {
          type: "object",
          required: ["sku", "qty", "note"],
          properties: {
            sku: { type: "string" },
            qty: { type: "number" },
            note: { type: "string" },
          },
        },
      },
    },
    (req) => {
      const who = (req as unknown as { who: { userId: string; theme: string } }).who
      return { ok: true, id: "ord_new", sku: req.body.sku, qty: req.body.qty, by: who.userId }
    },
  )
  await app.listen({ port })
} else if (framework === "hono") {
  const { Hono } = await import("hono")
  const { getCookie } = await import("hono/cookie")
  const { cors } = await import("hono/cors")
  const { secureHeaders } = await import("hono/secure-headers")
  const { validator } = await import("hono/validator")
  const app = new Hono<{ Variables: { userId: string; theme: string } }>()
  app.use("*", secureHeaders())
  app.use("*", cors({ origin: "https://app.example.com", credentials: true }))
  app.use("*", async (c, next) => {
    c.header("x-request-id", c.req.header("x-request-id") ?? crypto.randomUUID())
    const auth = c.req.header("authorization")
    if (auth === undefined || !auth.startsWith("Bearer ") || auth.length < 24) {
      return c.json({ ok: false, error: "unauthorized" }, 401)
    }
    c.set("userId", auth.slice(7, 19))
    c.set("theme", getCookie(c, "theme") ?? "light")
    await next()
    return undefined
  })
  app.get(
    "/api/orders",
    validator("query", (value, c) =>
      typeof value.limit === "string" ? { limit: value.limit } : c.json({ error: "invalid" }, 400),
    ),
    (c) => {
      const { limit } = c.req.valid("query")
      return c.json({
        user: c.get("userId"),
        theme: c.get("theme"),
        orders: ORDERS.slice(0, Number(limit) || 10),
        total: ORDERS.length,
      })
    },
  )
  app.post(
    "/api/orders",
    validator("json", (value, c) =>
      isOrderBody(value) ? value : c.json({ ok: false, error: "bad_body" }, 400),
    ),
    (c) => {
      const { sku, qty } = c.req.valid("json")
      return c.json({ ok: true, id: "ord_new", sku, qty, by: c.get("userId") })
    },
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
  app.use((req, res, next) => {
    for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v)
    res.setHeader("x-request-id", (req.headers["x-request-id"] as string) ?? crypto.randomUUID())
    next()
  })
  app.use((req, res, next) => {
    const who = authOf(req.headers.authorization, req.headers.cookie)
    if (who === undefined) {
      res.status(401).json({ ok: false, error: "unauthorized" })
      return
    }
    ;(req as unknown as { who: typeof who }).who = who
    next()
  })
  app.get("/api/orders", (req, res) => {
    const who = (req as unknown as { who: { userId: string; theme: string } }).who
    const limit = req.query.limit
    if (typeof limit !== "string") {
      res.status(400).json({ error: "invalid" })
      return
    }
    res.json({
      user: who.userId,
      theme: who.theme,
      orders: ORDERS.slice(0, Number(limit) || 10),
      total: ORDERS.length,
    })
  })
  app.post("/api/orders", (req, res) => {
    const who = (req as unknown as { who: { userId: string; theme: string } }).who
    const body: unknown = req.body
    if (!isOrderBody(body)) {
      res.status(400).json({ error: "invalid" })
      return
    }
    res.json({ ok: true, id: "ord_new", sku: body.sku, qty: body.qty, by: who.userId })
  })
  app.listen(port)
} else if (framework === "elysia") {
  const { Elysia, t } = await import("elysia")
  const { node } = await import("@elysiajs/node")
  new Elysia({ adapter: node() })
    .onAfterHandle(({ set, request }) => {
      set.headers["x-content-type-options"] = "nosniff"
      set.headers["x-frame-options"] = "DENY"
      set.headers["referrer-policy"] = "no-referrer"
      set.headers["strict-transport-security"] = "max-age=15552000; includeSubDomains"
      set.headers["access-control-allow-origin"] = "https://app.example.com"
      set.headers["access-control-allow-credentials"] = "true"
      set.headers["x-request-id"] = request.headers.get("x-request-id") ?? crypto.randomUUID()
    })
    .derive(({ request, cookie, status }) => {
      const auth = request.headers.get("authorization")
      if (auth === null || !auth.startsWith("Bearer ") || auth.length < 24) {
        return status(401, { ok: false, error: "unauthorized" }) as never
      }
      return { userId: auth.slice(7, 19), theme: cookie.theme?.value ?? "light" }
    })
    .get(
      "/api/orders",
      ({ query, userId, theme }) => ({
        user: userId,
        theme,
        orders: ORDERS.slice(0, Number(query.limit) || 10),
        total: ORDERS.length,
      }),
      { query: t.Object({ limit: t.String() }) },
    )
    .post(
      "/api/orders",
      ({ body, userId }) => ({ ok: true, id: "ord_new", sku: body.sku, qty: body.qty, by: userId }),
      { body: t.Object({ sku: t.String(), qty: t.Number(), note: t.String() }) },
    )
    .listen(port)
} else if (framework === "node-raw") {
  // The Node ceiling: node:http, manual routing + auth + validation. Same work, no framework.
  const server = createServer((req, res) => {
    const url = req.url ?? "/"
    if (!url.startsWith("/api/orders")) return sendJson(res, 404, { error: "not_found" })
    const who = authOf(req.headers.authorization, req.headers.cookie)
    const requestId = (req.headers["x-request-id"] as string) ?? crypto.randomUUID()
    if (who === undefined) {
      return sendJson(res, 401, { ok: false, error: "unauthorized" }, { "x-request-id": requestId })
    }
    if (req.method === "GET") {
      const search = new URL(url, "http://localhost").searchParams
      const limit = search.get("limit")
      if (limit === null)
        return sendJson(res, 400, { error: "invalid" }, { "x-request-id": requestId })
      return sendJson(
        res,
        200,
        {
          user: who.userId,
          theme: who.theme,
          orders: ORDERS.slice(0, Number(limit) || 10),
          total: ORDERS.length,
        },
        { "x-request-id": requestId },
      )
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch {
          return sendJson(res, 400, { error: "bad_json" }, { "x-request-id": requestId })
        }
        if (!isOrderBody(parsed)) {
          return sendJson(res, 400, { error: "invalid" }, { "x-request-id": requestId })
        }
        sendJson(
          res,
          200,
          { ok: true, id: "ord_new", sku: parsed.sku, qty: parsed.qty, by: who.userId },
          { "x-request-id": requestId },
        )
      })
      return
    }
    sendJson(res, 404, { error: "not_found" }, { "x-request-id": requestId })
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

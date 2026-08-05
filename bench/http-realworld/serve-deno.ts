/**
 * Per-framework REALISTIC-shape benchmark server - the Deno section. Mirrors
 * bench/http/serve-deno.ts; same route work as the Bun/Node sections.
 *
 *   deno run --allow-net --allow-env --no-check bench/http-realworld/serve-deno.ts <nifra|hono|elysia|deno-raw> <port>
 */
import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { cors } from "hono/cors"
import { secureHeaders } from "hono/secure-headers"
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
    "usage: deno run --allow-net --allow-env --no-check bench/http-realworld/serve-deno.ts <nifra|hono|elysia|deno-raw> <port>",
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

function isLimitQuery(v: unknown): v is { limit: string } {
  return typeof v === "object" && v !== null && "limit" in v && typeof v.limit === "string"
}

const orderBody: StandardSchemaV1<unknown, { sku: string; qty: number; note: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ sku: string; qty: number; note: string }> {
      return isOrderBody(value)
        ? { value }
        : { issues: [{ message: "expected { sku: string; qty: number; note: string }" }] }
    },
    types: undefined as unknown as StandardTypes<
      unknown,
      { sku: string; qty: number; note: string }
    >,
  },
}

const limitQuery: StandardSchemaV1<unknown, { limit: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ limit: string }> {
      return isLimitQuery(value) ? { value } : { issues: [{ message: "expected ?limit=string" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, { limit: string }>,
  },
}

const SEC: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=15552000; includeSubDomains",
  "access-control-allow-origin": "https://app.example.com",
  "access-control-allow-credentials": "true",
}

function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function authOf(req: Request): { userId: string; theme: string } | undefined {
  const auth = req.headers.get("authorization")
  if (auth === null || !auth.startsWith("Bearer ") || auth.length < 24) return undefined
  return {
    userId: auth.slice(7, 19),
    theme: readCookie(req.headers.get("cookie"), "theme") ?? "light",
  }
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
      .use({
        name: "sec",
        beforeHandle: (c) => {
          for (const [k, v] of Object.entries(SEC)) c.set.headers[k] = v
          c.set.headers["x-request-id"] = c.req.headers.get("x-request-id") ?? crypto.randomUUID()
        },
      })
      .derive((c) => {
        const auth = c.req.headers.get("authorization")
        if (auth === null || !auth.startsWith("Bearer ") || auth.length < 24) {
          throw new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        }
        return { userId: auth.slice(7, 19), theme: c.cookies.theme ?? "light" }
      })
      .get("/api/orders", { query: limitQuery }, (c) => ({
        user: c.userId,
        theme: c.theme,
        orders: ORDERS.slice(0, Number(c.query.limit) || 10),
        total: ORDERS.length,
      }))
      .post("/api/orders", { body: orderBody }, (c) => ({
        ok: true,
        id: "ord_new",
        sku: c.body.sku,
        qty: c.body.qty,
        by: c.userId,
      })),
    { port },
  )
} else if (framework === "hono") {
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
  Deno.serve({ port, onListen() {} }, app.fetch)
} else if (framework === "elysia") {
  const { Elysia, t } = await import("elysia")
  const { WebStandardAdapter } = await import("elysia/adapter/web-standard")
  const app = new Elysia({ adapter: WebStandardAdapter })
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
  Deno.serve({ port, onListen() {} }, app.fetch)
} else if (framework === "deno-raw") {
  Deno.serve({ port, onListen() {} }, async (req) => {
    const pathname = pathnameOf(req.url)
    if (!pathname.startsWith("/api/orders")) return new Response("not found", { status: 404 })
    const who = authOf(req)
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID()
    const headers = { ...SEC, "x-request-id": requestId }
    if (who === undefined) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers })
    }
    if (req.method === "GET") {
      const limit = new URL(req.url).searchParams.get("limit")
      if (limit === null) return new Response("invalid", { status: 400, headers })
      return Response.json(
        {
          user: who.userId,
          theme: who.theme,
          orders: ORDERS.slice(0, Number(limit) || 10),
          total: ORDERS.length,
        },
        { headers },
      )
    }
    if (req.method === "POST") {
      const body: unknown = await req.json().catch(() => undefined)
      if (!isOrderBody(body)) return new Response("invalid", { status: 400, headers })
      return Response.json(
        { ok: true, id: "ord_new", sku: body.sku, qty: body.qty, by: who.userId },
        { headers },
      )
    }
    return new Response("not found", { status: 404, headers })
  })
} else {
  throw new Error(`unknown framework: ${framework ?? "(none)"}`)
}

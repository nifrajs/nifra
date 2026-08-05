/**
 * Per-framework REALISTIC-shape benchmark server, selected by CLI arg - the Bun section. Mirrors
 * bench/http/serve.ts's structure exactly; the difference is the route itself. Every framework here
 * does the SAME work: security headers + CORS + a request-id header + bearer-token auth + a cookie
 * read + validated query (GET) or body (POST) + a ~2.4 KB JSON response.
 *
 * This is deliberately NOT the bare-route shape bench/http/ measures - auth and middleware are exactly
 * what knocks a route off nifra's fused Web lane onto the general lifecycle path, so this suite
 * answers "what does a route that looks like production actually get," separately from "what does the
 * fast path get on a route with nothing on it." Read both suites together; neither replaces the other.
 *
 *   bun run bench/http-realworld/serve.ts <nifra|hono|elysia|bun-native> <port>
 */
const framework = process.argv[2]
const port = Number(process.argv[3])

if (!Number.isInteger(port)) {
  throw new Error(
    "usage: bun run bench/http-realworld/serve.ts <nifra|hono|elysia|bun-native> <port>",
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

if (framework === "nifra") {
  const { makeNifraApp } = await import("./_nifra-app.ts")
  makeNifraApp().listen(port)
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
  Bun.serve({ port, fetch: app.fetch })
} else if (framework === "elysia") {
  const { Elysia, t } = await import("elysia")
  new Elysia()
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
} else if (framework === "bun-native") {
  // The realistic-shape ceiling: hand-written on Bun.serve's native routes table, same work, no
  // framework. Security headers, CORS, request-id, and the auth guard are applied by hand.
  const SEC: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=15552000; includeSubDomains",
    "access-control-allow-origin": "https://app.example.com",
    "access-control-allow-credentials": "true",
  }
  function baseHeaders(req: Request): Record<string, string> {
    return { ...SEC, "x-request-id": req.headers.get("x-request-id") ?? crypto.randomUUID() }
  }
  function readCookie(req: Request, name: string): string | undefined {
    const raw = req.headers.get("cookie")
    if (raw === null) return undefined
    for (const part of raw.split(";")) {
      const eq = part.indexOf("=")
      if (eq === -1) continue
      if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
    }
    return undefined
  }
  function authOrNull(req: Request): { userId: string; theme: string } | undefined {
    const auth = req.headers.get("authorization")
    if (auth === null || !auth.startsWith("Bearer ") || auth.length < 24) return undefined
    return { userId: auth.slice(7, 19), theme: readCookie(req, "theme") ?? "light" }
  }
  Bun.serve({
    port,
    routes: {
      "/api/orders": {
        GET: (req) => {
          const headers = baseHeaders(req)
          const who = authOrNull(req)
          if (who === undefined) {
            return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers })
          }
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
        },
        POST: async (req) => {
          const headers = baseHeaders(req)
          const who = authOrNull(req)
          if (who === undefined) {
            return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers })
          }
          const body: unknown = await req.json().catch(() => undefined)
          if (!isOrderBody(body)) return new Response("invalid", { status: 400, headers })
          return Response.json(
            { ok: true, id: "ord_new", sku: body.sku, qty: body.qty, by: who.userId },
            { headers },
          )
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  })
} else {
  throw new Error(`unknown framework: ${framework ?? "(none)"}`)
}

export {}
